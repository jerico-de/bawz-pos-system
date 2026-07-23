import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('⚠️  Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env — API calls will fail until set.');
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const handle = (res, promise) =>
  promise.then(({ data, error }) => {
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  }).catch(err => res.status(500).json({ error: err.message }));

// ── Products ────────────────────────────────────────────
app.get('/api/products', (req, res) => {
  handle(res, supabase.from('products').select('*').order('name'));
});

app.post('/api/products', (req, res) => {
  const { name, category, sku, size, price, stock } = req.body;
  handle(res, supabase.from('products')
    .insert([{ name, category: category || 'Uncategorized', sku: sku || null, size: size || null, price, stock: stock ?? 0 }])
    .select().single());
});

app.put('/api/products/:id', (req, res) => {
  const { name, category, sku, size, price, stock } = req.body;
  handle(res, supabase.from('products')
    .update({ name, category, sku: sku || null, size: size || null, price, stock })
    .eq('id', req.params.id).select().single());
});

app.delete('/api/products/:id', (req, res) => {
  handle(res, supabase.from('products').delete().eq('id', req.params.id));
});

// ── Cashiers ────────────────────────────────────────────
app.get('/api/cashiers', (req, res) => {
  handle(res, supabase.from('cashiers').select('*').order('name'));
});

app.post('/api/cashiers', (req, res) => {
  const { name } = req.body;
  handle(res, supabase.from('cashiers').insert([{ name }]).select().single());
});

app.put('/api/cashiers/:id', (req, res) => {
  const { active, name } = req.body;
  const patch = {};
  if (active !== undefined) patch.active = active;
  if (name !== undefined) patch.name = name;
  handle(res, supabase.from('cashiers').update(patch).eq('id', req.params.id).select().single());
});

// ── Sales ───────────────────────────────────────────────
app.post('/api/sales', async (req, res) => {
  const { cashier_id, payment_method, reference_number, items, sponsor_name, sponsor_brand, sponsor_representative } = req.body;
  const { data, error } = await supabase.rpc('create_sale', {
    p_cashier_id: cashier_id,
    p_payment_method: payment_method,
    p_reference_number: reference_number || null,
    p_items: items,
    p_sponsor_name: sponsor_name || null,
    p_sponsor_brand: sponsor_brand || null,
    p_sponsor_representative: sponsor_representative || null
  });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ sale_id: data });
});

app.get('/api/sales', async (req, res) => {
  const { from, to } = req.query;
  let query = supabase
    .from('sales')
    .select('*, cashiers(name), sale_items(*)')
    .order('created_at', { ascending: false });
  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to);
  handle(res, query);
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Merch POS running at http://localhost:${PORT}`));