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

async function logAudit({ action, entity_type, entity_id, summary, details, actor_cashier_id, actor_name }) {
  const { error } = await supabase.from('audit_log').insert([{
    action, entity_type, entity_id, summary, details: details || null,
    actor_cashier_id: actor_cashier_id || null,
    actor_name: actor_name || null
  }]);
  // Never let a logging failure break the actual operation — just surface it in the server console.
  if (error) console.error('audit_log insert failed:', error.message);
}

// ── Products ────────────────────────────────────────────
app.get('/api/products', (req, res) => {
  handle(res, supabase.from('products').select('*').order('sort_order', { ascending: true }).order('name', { ascending: true }));
});

app.post('/api/products', async (req, res) => {
  const { name, category, sku, size, price, stock, discounts, actor_cashier_id, actor_name } = req.body;
  try {
    const { data: maxRow } = await supabase
      .from('products').select('sort_order').order('sort_order', { ascending: false }).limit(1).maybeSingle();
    const nextOrder = (maxRow?.sort_order || 0) + 10;

    const { data, error } = await supabase.from('products')
      .insert([{
        name, category: category || 'Uncategorized', sku: sku || null, size: size || null,
        price, stock: stock ?? 0, sort_order: nextOrder,
        discounts: Array.isArray(discounts) ? discounts : []
      }])
      .select().single();
    if (error) throw error;

    await logAudit({
      action: 'product_create', entity_type: 'product', entity_id: data.id,
      actor_cashier_id, actor_name,
      summary: `Added "${data.name}"${data.size ? ' · ' + data.size : ''} — stock ${data.stock}, ₱${data.price}`,
      details: { new: data }
    });

    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/products/:id', async (req, res) => {
  const { name, category, sku, size, price, stock, discounts, actor_cashier_id, actor_name } = req.body;
  try {
    const { data: before } = await supabase.from('products').select('*').eq('id', req.params.id).single();

    const { data, error } = await supabase.from('products')
      .update({
        name, category, sku: sku || null, size: size || null, price, stock,
        discounts: Array.isArray(discounts) ? discounts : []
      })
      .eq('id', req.params.id).select().single();
    if (error) throw error;

    const changes = [];
    if (before) {
      if (before.name !== data.name) changes.push(`name "${before.name}" → "${data.name}"`);
      if (Number(before.price) !== Number(data.price)) changes.push(`price ₱${before.price} → ₱${data.price}`);
      if (Number(before.stock) !== Number(data.stock)) changes.push(`stock ${before.stock} → ${data.stock}`);
      if ((before.size || '') !== (data.size || '')) changes.push(`size "${before.size || '—'}" → "${data.size || '—'}"`);
      if ((before.category || '') !== (data.category || '')) changes.push(`category "${before.category || '—'}" → "${data.category || '—'}"`);
      if (JSON.stringify(before.discounts || []) !== JSON.stringify(data.discounts || [])) changes.push(`discounts updated`);
    }

    await logAudit({
      action: 'product_update', entity_type: 'product', entity_id: data.id,
      actor_cashier_id, actor_name,
      summary: `Updated "${data.name}"${changes.length ? ' — ' + changes.join(', ') : ''}`,
      details: { before, after: data }
    });

    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  const { actor_cashier_id, actor_name } = req.body || {};
  try {
    const { data: before } = await supabase.from('products').select('*').eq('id', req.params.id).single();
    const { error } = await supabase.from('products').delete().eq('id', req.params.id);
    if (error) throw error;

    await logAudit({
      action: 'product_delete', entity_type: 'product', entity_id: req.params.id,
      actor_cashier_id, actor_name,
      summary: `Deleted "${before?.name || 'unknown item'}"${before?.size ? ' · ' + before.size : ''}`,
      details: { deleted: before }
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Bulk update sort_order for drag-reordered cards
app.patch('/api/products/reorder', async (req, res) => {
  const { order } = req.body; // [{ id, sort_order }]
  try {
    if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: 'No order given.' });
    await Promise.all(order.map(o =>
      supabase.from('products').update({ sort_order: o.sort_order }).eq('id', o.id)
    ));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Cashiers ────────────────────────────────────────────
app.get('/api/cashiers', (req, res) => {
  handle(res, supabase.from('cashiers').select('*').order('name'));
});

app.post('/api/cashiers', async (req, res) => {
  const { name, actor_cashier_id, actor_name } = req.body;
  try {
    const { data, error } = await supabase.from('cashiers').insert([{ name }]).select().single();
    if (error) throw error;

    await logAudit({
      action: 'cashier_create', entity_type: 'cashier', entity_id: data.id,
      actor_cashier_id, actor_name,
      summary: `Added cashier "${data.name}"`,
      details: { new: data }
    });

    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/cashiers/:id', async (req, res) => {
  const { active, name, actor_cashier_id, actor_name } = req.body;
  const patch = {};
  if (active !== undefined) patch.active = active;
  if (name !== undefined) patch.name = name;
  try {
    const { data, error } = await supabase.from('cashiers').update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;

    await logAudit({
      action: 'cashier_update', entity_type: 'cashier', entity_id: data.id,
      actor_cashier_id, actor_name,
      summary: `${active !== undefined ? (active ? 'Activated' : 'Deactivated') : 'Updated'} cashier "${data.name}"`,
      details: { after: data }
    });

    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Sales ───────────────────────────────────────────────
app.post('/api/sales', async (req, res) => {
  const { cashier_id, payment_method, reference_number, items, sponsor_name, sponsor_brand, sponsor_representative } = req.body;
  try {
    const { data, error } = await supabase.rpc('create_sale', {
      p_cashier_id: cashier_id,
      p_payment_method: payment_method,
      p_reference_number: reference_number || null,
      p_items: items,
      p_sponsor_name: sponsor_name || null,
      p_sponsor_brand: sponsor_brand || null,
      p_sponsor_representative: sponsor_representative || null
    });
    if (error) throw error;

    // Pull the real rows create_sale just inserted (name/size/price snapshot)
    // rather than the raw cart payload, so the audit trail shows full detail.
    const { data: insertedItems } = await supabase.from('sale_items').select('*').eq('sale_id', data);

    const { data: cashier } = await supabase.from('cashiers').select('name').eq('id', cashier_id).single();
    const itemCount = (items || []).reduce((s, i) => s + (i.quantity || 0), 0);

    await logAudit({
      action: 'sale_create', entity_type: 'sale', entity_id: data,
      actor_cashier_id: cashier_id, actor_name: cashier?.name,
      summary: `New sale — ${itemCount} item(s), ${payment_method}${payment_method === 'sponsor' ? ` (${sponsor_brand || 'sponsor'})` : ''}`,
      details: {
        items: insertedItems || items,
        payment_method,
        reference_number: payment_method === 'online' ? (reference_number || null) : null,
        sponsor: payment_method === 'sponsor'
          ? { name: sponsor_name || null, brand: sponsor_brand || null, representative: sponsor_representative || null }
          : null
      }
    });

    res.json({ sale_id: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/sales', async (req, res) => {
  const { from, to } = req.query;
  let query = supabase
    .from('sales')
    .select('*, cashiers!sales_cashier_id_fkey(name), sale_items(*)')
    .order('created_at', { ascending: false });
  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to);
  handle(res, query);
});

// Edit or void an existing sale. Not atomic (no RPC available for this yet —
// see migration.sql notes) but every step is checked and errors bail out
// before anything destructive happens to sale_items.
app.put('/api/sales/:id', async (req, res) => {
  const saleId = req.params.id;
  const {
    items, payment_method, reference_number,
    sponsor_name, sponsor_brand, sponsor_representative,
    actor_cashier_id, actor_name, reason, voided
  } = req.body;

  try {
    const { data: existingSale, error: saleErr } = await supabase
      .from('sales').select('*, sale_items(*)').eq('id', saleId).single();
    // (no cashiers embed needed here — only sale_items, so no ambiguity)
    if (saleErr || !existingSale) return res.status(404).json({ error: 'Sale not found.' });
    if (existingSale.voided) return res.status(400).json({ error: 'This sale has already been voided.' });

    const oldItems = existingSale.sale_items || [];

    // ── Void: restore all stock, keep the record, flag it ──
    if (voided) {
      for (const oi of oldItems) {
        const { data: prod } = await supabase.from('products').select('stock').eq('id', oi.product_id).single();
        if (prod) await supabase.from('products').update({ stock: prod.stock + oi.quantity }).eq('id', oi.product_id);
      }

      const { error: updErr } = await supabase.from('sales').update({
        voided: true, edited: true, edited_at: new Date().toISOString(),
        edited_by_cashier_id: actor_cashier_id || null, edit_reason: reason || 'Voided'
      }).eq('id', saleId);
      if (updErr) throw updErr;

      await logAudit({
        action: 'sale_void', entity_type: 'sale', entity_id: saleId,
        actor_cashier_id, actor_name,
        summary: `Voided sale (was ${existingSale.subtotal})${reason ? ` — reason: ${reason}` : ''}`,
        details: { old_items: oldItems, reason }
      });

      return res.json({ ok: true, voided: true });
    }

    // ── Edit: reconcile item quantities against stock ──
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'A sale needs at least one item — use void to cancel it entirely.' });
    }

    // A discounted line and its full-price remainder arrive as separate
    // entries for the same product_id, so quantities are aggregated per
    // product for the stock diff, but each entry keeps its own row (and
    // its own price) when sale_items gets rebuilt below.
    const aggregateQty = list => {
      const map = new Map();
      for (const it of list) map.set(it.product_id, (map.get(it.product_id) || 0) + (it.quantity || 0));
      return map;
    };
    const newAgg = aggregateQty(items);
    const oldAgg = aggregateQty(oldItems);
    const allIds = new Set([...newAgg.keys(), ...oldAgg.keys()]);
    const changeLines = [];
    if (existingSale.payment_method !== payment_method) {
      changeLines.push(`payment: ${existingSale.payment_method} → ${payment_method}`);
    }

    for (const pid of allIds) {
      const oldQty = oldAgg.get(pid) || 0;
      const newQty = newAgg.get(pid) || 0;
      const delta = newQty - oldQty; // positive = deduct more stock, negative = return stock
      if (delta === 0) continue;

      const { data: prod, error: prodErr } = await supabase.from('products').select('stock,name').eq('id', pid).single();
      if (prodErr || !prod) throw new Error('One of the items in this sale no longer exists in inventory.');

      const nextStock = prod.stock - delta;
      if (nextStock < 0) throw new Error(`Not enough stock for "${prod.name}" to apply this edit (only ${prod.stock} left).`);

      await supabase.from('products').update({ stock: nextStock }).eq('id', pid);
      changeLines.push(`${prod.name}: ${oldQty} → ${newQty}`);
    }

    // Rebuild sale_items with a fresh snapshot of name/size/price — one row
    // per entry (not deduped), so a discounted unit and its full-price
    // siblings stay as separate, individually-priced rows.
    // Sponsor/freebie sales carry no price — it's not real income.
    const isSponsorEdit = payment_method === 'sponsor';
    await supabase.from('sale_items').delete().eq('sale_id', saleId);
    let subtotal = 0;
    const newRows = [];
    for (const it of items) {
      const qty = it.quantity;
      if (!qty || qty <= 0) continue;

      const { data: prod } = await supabase.from('products').select('name,size,price,discounts').eq('id', it.product_id).single();
      let unitPrice = prod?.price || 0;
      let discountName = null, buyerName = null;

      if (it.discount_name) {
        const match = (prod?.discounts || []).find(d => d.name === it.discount_name);
        if (!match) throw new Error(`Unknown discount "${it.discount_name}" for ${prod?.name || 'item'}.`);
        if (!it.buyer_name || !String(it.buyer_name).trim()) {
          throw new Error(`Buyer name is required for the discount on ${prod?.name || 'item'}.`);
        }
        unitPrice = Number(match.price);
        discountName = it.discount_name;
        buyerName = String(it.buyer_name).trim();
      }

      if (isSponsorEdit) unitPrice = 0;
      const lineTotal = unitPrice * qty;
      subtotal += lineTotal;

      newRows.push({
        sale_id: saleId, product_id: it.product_id,
        product_name: prod?.name, product_size: prod?.size,
        quantity: qty, unit_price: unitPrice, line_total: lineTotal,
        discount_name: discountName, buyer_name: buyerName
      });
    }
    if (newRows.length) {
      const { error: insErr } = await supabase.from('sale_items').insert(newRows);
      if (insErr) throw insErr;
    }

    const { error: updSaleErr } = await supabase.from('sales').update({
      subtotal,
      payment_method,
      reference_number: payment_method === 'online' ? (reference_number || null) : null,
      sponsor_name: payment_method === 'sponsor' ? (sponsor_name || null) : null,
      sponsor_brand: payment_method === 'sponsor' ? (sponsor_brand || null) : null,
      sponsor_representative: payment_method === 'sponsor' ? (sponsor_representative || null) : null,
      edited: true, edited_at: new Date().toISOString(),
      edited_by_cashier_id: actor_cashier_id || null, edit_reason: reason || null
    }).eq('id', saleId);
    if (updSaleErr) throw updSaleErr;

    await logAudit({
      action: 'sale_edit', entity_type: 'sale', entity_id: saleId,
      actor_cashier_id, actor_name,
      summary: `Edited sale — ${changeLines.join(', ') || 'payment info updated'}${reason ? ` (reason: ${reason})` : ''}`,
      details: {
        old_items: oldItems, new_items: newRows, reason,
        old_payment_method: existingSale.payment_method, payment_method,
        old_reference_number: existingSale.reference_number || null,
        reference_number: payment_method === 'online' ? (reference_number || null) : null,
        old_sponsor: {
          name: existingSale.sponsor_name || null,
          brand: existingSale.sponsor_brand || null,
          representative: existingSale.sponsor_representative || null
        },
        sponsor: payment_method === 'sponsor' ? {
          name: sponsor_name || null, brand: sponsor_brand || null, representative: sponsor_representative || null
        } : null
      }
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Audit log ───────────────────────────────────────────
app.get('/api/audit-log', (req, res) => {
  handle(res, supabase.from('audit_log').select('*, cashiers(name)').order('created_at', { ascending: false }).limit(500));
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Merch POS running at http://localhost:${PORT}`));