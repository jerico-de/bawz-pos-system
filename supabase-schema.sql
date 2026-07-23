-- Run this whole file once in Supabase: Project -> SQL Editor -> New query -> paste -> Run

create extension if not exists "pgcrypto";

-- ── Cashiers ─────────────────────────────────────────────
create table if not exists cashiers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ── Products ─────────────────────────────────────────────
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null default 'Uncategorized',
  sku text unique,
  price numeric(10,2) not null check (price >= 0),
  stock integer not null default 0 check (stock >= 0),
  created_at timestamptz not null default now()
);

-- ── Sales (one row per transaction) ─────────────────────
create table if not exists sales (
  id uuid primary key default gen_random_uuid(),
  cashier_id uuid references cashiers(id),
  payment_method text not null check (payment_method in ('cash', 'online', 'sponsor')),
  reference_number text,
  sponsor_name text,
  sponsor_brand text,
  sponsor_representative text,
  subtotal numeric(10,2) not null default 0,
  created_at timestamptz not null default now()
);

-- ── Sale line items ──────────────────────────────────────
create table if not exists sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid references sales(id) on delete cascade,
  product_id uuid references products(id),
  product_name text not null,
  unit_price numeric(10,2) not null,
  quantity integer not null check (quantity > 0),
  line_total numeric(10,2) not null
);

create index if not exists idx_sales_created_at on sales(created_at desc);
create index if not exists idx_sale_items_sale_id on sale_items(sale_id);

-- ── Atomic checkout: validates stock, writes sale + items, decrements stock ──
-- p_items shape: [{"product_id": "uuid", "quantity": 2}, ...]
create or replace function create_sale(
  p_cashier_id uuid,
  p_payment_method text,
  p_reference_number text,
  p_items jsonb,
  p_sponsor_name text default null,
  p_sponsor_brand text default null,
  p_sponsor_representative text default null
) returns uuid
language plpgsql
as $$
declare
  v_sale_id uuid;
  v_item jsonb;
  v_product record;
  v_qty integer;
  v_subtotal numeric(10,2) := 0;
  v_line_total numeric(10,2);
begin
  if p_payment_method = 'online' and (p_reference_number is null or trim(p_reference_number) = '') then
    raise exception 'Reference number is required for online payments';
  end if;

  if p_payment_method = 'sponsor' and (
       p_sponsor_name is null or trim(p_sponsor_name) = '' or
       p_sponsor_brand is null or trim(p_sponsor_brand) = '' or
       p_sponsor_representative is null or trim(p_sponsor_representative) = ''
     ) then
    raise exception 'Sponsor name, brand, and representative are all required for sponsor/freebie transactions';
  end if;

  if jsonb_array_length(p_items) = 0 then
    raise exception 'Cart is empty';
  end if;

  insert into sales (cashier_id, payment_method, reference_number, sponsor_name, sponsor_brand, sponsor_representative, subtotal)
  values (
    p_cashier_id, p_payment_method, nullif(trim(p_reference_number), ''),
    nullif(trim(p_sponsor_name), ''), nullif(trim(p_sponsor_brand), ''), nullif(trim(p_sponsor_representative), ''),
    0
  )
  returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := (v_item->>'quantity')::int;

    select * into v_product from products
      where id = (v_item->>'product_id')::uuid
      for update;

    if v_product is null then
      raise exception 'Product not found';
    end if;

    if v_product.stock < v_qty then
      raise exception 'Not enough stock for %: only % left', v_product.name, v_product.stock;
    end if;

    v_line_total := v_product.price * v_qty;
    v_subtotal := v_subtotal + v_line_total;

    insert into sale_items (sale_id, product_id, product_name, unit_price, quantity, line_total)
    values (v_sale_id, v_product.id, v_product.name, v_product.price, v_qty, v_line_total);

    update products set stock = stock - v_qty where id = v_product.id;
  end loop;

  update sales set subtotal = v_subtotal where id = v_sale_id;

  return v_sale_id;
end;
$$;

-- Seed a couple of cashiers so the dropdown isn't empty (edit/remove as you like)
insert into cashiers (name) values ('Jigs') on conflict do nothing;
