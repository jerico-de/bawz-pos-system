const API = '/api';
const peso = n => '₱' + Number(n).toFixed(2);

let products = [];
let cashiers = [];
let sales = [];
let auditLog = [];
let cart = [];              // [{product_id, name, size, sku, price, stock, qty}]
let activeCategory = 'All';
let paymentMethod = 'cash';
let searchTerm = '';
let inventorySort = { key: 'name', dir: 'asc' };

let currentActorId = null;
let currentActorName = null;

// ── Fetch helpers ────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3200);
}

function requireActor(errEl) {
  if (currentActorId) return true;
  const msg = "Select who's on shift first (top-left cashier picker).";
  if (errEl) errEl.textContent = msg; else toast(msg, true);
  return false;
}

// ── Navigation ────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

function switchView(view) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'dashboard') renderDashboard();
  if (view === 'inventory') renderInventoryTable();
  if (view === 'history') renderHistoryTable();
  if (view === 'audit') renderAuditTable();
  if (view === 'cashiers') renderCashiersTable();
}

// ── Load everything ───────────────────────────────────────
async function loadAll() {
  try {
    [products, cashiers, sales, auditLog] = await Promise.all([
      api('/products'),
      api('/cashiers'),
      api('/sales'),
      api('/audit-log')
    ]);
    renderCashierSelect();
    renderCategories();
    renderGrid();
    renderDashboard();
  } catch (err) {
    toast('Could not load data — check your Supabase setup. ' + err.message, true);
  }
}

// ── POS: categories + grid ────────────────────────────────
function renderCategories() {
  const cats = ['All', ...new Set(products.map(p => p.category || 'Uncategorized'))];
  const row = document.getElementById('categoryRow');
  row.innerHTML = cats.map(c =>
    `<button class="chip ${c === activeCategory ? 'active' : ''}" data-cat="${c}">${c}</button>`
  ).join('');
  row.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      activeCategory = chip.dataset.cat;
      renderCategories();
      renderGrid();
    });
  });
}

function visibleProducts() {
  const term = searchTerm.trim().toLowerCase();
  return products
    .filter(p => {
      const matchesCat = activeCategory === 'All' || (p.category || 'Uncategorized') === activeCategory;
      const matchesSearch = !term || p.name.toLowerCase().includes(term) || (p.sku || '').toLowerCase().includes(term);
      return matchesCat && matchesSearch;
    })
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
}

function renderGrid() {
  const grid = document.getElementById('posGrid');
  const list = visibleProducts();

  if (!list.length) {
    grid.innerHTML = `<p class="empty-hint">No items match.</p>`;
    return;
  }

  grid.innerHTML = list.map(p => {
    const inCart = cart.find(c => c.product_id === p.id);
    const remaining = p.stock - (inCart ? inCart.qty : 0);
    const low = remaining <= 5;
    return `
      <button class="tag-card" data-id="${p.id}" ${remaining <= 0 ? 'disabled' : ''}>
        <span class="punch"></span>
        <span class="tc-cat">${p.category || 'Uncategorized'}</span><br>
        <span class="tc-name">${p.name}${p.size ? ' · ' + p.size : ''}</span><br>
        <span class="tc-price">${peso(p.price)}</span><br>
        <span class="tc-stock ${low ? 'low' : ''}">${remaining <= 0 ? 'Out of stock' : remaining + ' left'}</span>
      </button>`;
  }).join('');

  grid.querySelectorAll('.tag-card').forEach(card => {
    card.addEventListener('click', () => addToCart(card.dataset.id));
    attachDragHandlers(card);
  });
}

document.getElementById('posSearch').addEventListener('input', e => {
  searchTerm = e.target.value;
  renderGrid();
});

// ── Drag-to-reorder POS cards ──────────────────────────────
let dragSrcId = null;

function attachDragHandlers(card) {
  card.draggable = true;
  card.addEventListener('dragstart', () => {
    dragSrcId = card.dataset.id;
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  card.addEventListener('dragover', e => e.preventDefault());
  card.addEventListener('drop', e => {
    e.preventDefault();
    const targetId = card.dataset.id;
    if (!dragSrcId || dragSrcId === targetId) return;
    reorderCards(dragSrcId, targetId);
    dragSrcId = null;
  });
}

async function reorderCards(srcId, targetId) {
  const list = visibleProducts();
  const srcIdx = list.findIndex(p => p.id === srcId);
  const targetIdx = list.findIndex(p => p.id === targetId);
  if (srcIdx === -1 || targetIdx === -1) return;

  const [moved] = list.splice(srcIdx, 1);
  list.splice(targetIdx, 0, moved);

  const order = list.map((p, i) => ({ id: p.id, sort_order: (i + 1) * 10 }));
  order.forEach(o => { const p = products.find(x => x.id === o.id); if (p) p.sort_order = o.sort_order; });
  renderGrid();

  try {
    await api('/products/reorder', { method: 'PATCH', body: JSON.stringify({ order }) });
  } catch (err) {
    toast('Could not save the new order: ' + err.message, true);
    await loadAll();
  }
}

// ── Cart ──────────────────────────────────────────────────
function addToCart(productId) {
  const p = products.find(x => x.id === productId);
  if (!p) return;
  const line = cart.find(c => c.product_id === productId);
  const currentQty = line ? line.qty : 0;
  if (currentQty >= p.stock) { toast(`Only ${p.stock} of "${p.name}" in stock.`, true); return; }
  if (line) line.qty++;
  else cart.push({ product_id: p.id, name: p.name, size: p.size, sku: p.sku, price: p.price, stock: p.stock, qty: 1 });
  renderCart();
  renderGrid();
}

function changeQty(productId, delta) {
  const line = cart.find(c => c.product_id === productId);
  if (!line) return;
  const p = products.find(x => x.id === productId);
  const next = line.qty + delta;
  if (next <= 0) { cart = cart.filter(c => c.product_id !== productId); }
  else if (p && next > p.stock) { toast(`Only ${p.stock} in stock.`, true); return; }
  else { line.qty = next; }
  renderCart();
  renderGrid();
}

function renderCart() {
  const wrap = document.getElementById('cartItems');
  const isSponsor = paymentMethod === 'sponsor';
  if (!cart.length) {
    wrap.innerHTML = `<p class="empty-hint">Cart is empty — add something from the grid.</p>`;
  } else {
    wrap.innerHTML = cart.map(c => `
      <div class="cart-line">
        <div class="cl-name">${c.name}${c.size ? ' · ' + c.size : ''}<small>${c.sku || ''}</small></div>
        <div class="cl-qty">
          <button data-id="${c.product_id}" data-d="-1">−</button>
          <span>${c.qty}</span>
          <button data-id="${c.product_id}" data-d="1">+</button>
        </div>
        <div class="cl-total">${isSponsor ? 'Free' : peso(c.price * c.qty)}</div>
        <button class="cl-remove" data-id="${c.product_id}" data-d="remove">×</button>
      </div>
    `).join('');
    wrap.querySelectorAll('button[data-d]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.d === 'remove') { cart = cart.filter(c => c.product_id !== btn.dataset.id); renderCart(); renderGrid(); }
        else changeQty(btn.dataset.id, parseInt(btn.dataset.d));
      });
    });
  }
  const total = isSponsor ? 0 : cart.reduce((sum, c) => sum + c.price * c.qty, 0);
  document.getElementById('cartTotal').textContent = peso(total);
}

document.getElementById('clearCartBtn').addEventListener('click', () => {
  cart = [];
  renderCart();
  renderGrid();
});

// ── Payment method (new sale) ──────────────────────────────
document.querySelectorAll('#view-pos .pay-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    paymentMethod = btn.dataset.method;
    document.querySelectorAll('#view-pos .pay-opt').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('refField').classList.toggle('hidden', paymentMethod !== 'online');
    document.getElementById('sponsorFields').classList.toggle('hidden', paymentMethod !== 'sponsor');
    renderCart();
  });
});

// ── Cashier / active-actor selection ───────────────────────
function renderCashierSelect() {
  const active = cashiers.filter(c => c.active);
  const options = active.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  const posSel = document.getElementById('cashierSelect');
  const globalSel = document.getElementById('globalCashierSelect');

  [posSel, globalSel].forEach(sel => {
    sel.innerHTML = `<option value="">— none —</option>` + options;
  });

  // Keep a previously chosen actor selected if they're still active; otherwise clear it.
  if (currentActorId && !active.some(c => c.id === currentActorId)) {
    currentActorId = null;
    currentActorName = null;
  }
  if (!currentActorId && active.length === 1) {
    currentActorId = active[0].id;
    currentActorName = active[0].name;
  }
  posSel.value = currentActorId || '';
  globalSel.value = currentActorId || '';
}

function setActor(id) {
  const c = cashiers.find(x => x.id === id);
  currentActorId = c ? c.id : null;
  currentActorName = c ? c.name : null;
  document.getElementById('cashierSelect').value = currentActorId || '';
  document.getElementById('globalCashierSelect').value = currentActorId || '';
}

document.getElementById('cashierSelect').addEventListener('change', e => setActor(e.target.value));
document.getElementById('globalCashierSelect').addEventListener('change', e => setActor(e.target.value));

// ── Checkout ──────────────────────────────────────────────
document.getElementById('checkoutBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('posError');
  errEl.textContent = '';

  if (!cart.length) { errEl.textContent = 'Cart is empty.'; return; }
  const cashierId = document.getElementById('cashierSelect').value;
  if (!cashierId) { errEl.textContent = 'Add a cashier first (see Cashiers tab).'; return; }
  const refNumber = document.getElementById('refNumber').value.trim();
  if (paymentMethod === 'online' && !refNumber) { errEl.textContent = 'Reference number is required for online payments.'; return; }

  const sponsorName = document.getElementById('sponsorName').value.trim();
  const sponsorBrand = document.getElementById('sponsorBrand').value.trim();
  const sponsorRep = document.getElementById('sponsorRep').value.trim();
  if (paymentMethod === 'sponsor' && !sponsorName && !sponsorBrand && !sponsorRep) {
    errEl.textContent = 'Fill in at least one of: sponsor name, brand, or representative.';
    return;
  }

  const btn = document.getElementById('checkoutBtn');
  btn.disabled = true;
  btn.textContent = 'Processing…';

  try {
    await api('/sales', {
      method: 'POST',
      body: JSON.stringify({
        cashier_id: cashierId,
        payment_method: paymentMethod,
        reference_number: paymentMethod === 'online' ? refNumber : null,
        sponsor_name: paymentMethod === 'sponsor' ? sponsorName : null,
        sponsor_brand: paymentMethod === 'sponsor' ? sponsorBrand : null,
        sponsor_representative: paymentMethod === 'sponsor' ? sponsorRep : null,
        items: cart.map(c => ({ product_id: c.product_id, quantity: c.qty }))
      })
    });
    toast('Sale completed.');
    cart = [];
    document.getElementById('refNumber').value = '';
    document.getElementById('sponsorName').value = '';
    document.getElementById('sponsorBrand').value = '';
    document.getElementById('sponsorRep').value = '';
    renderCart();
    await loadAll();
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Complete sale';
  }
});

// ── Dashboard ─────────────────────────────────────────────
function renderDashboard() {
  const todayStr = new Date().toDateString();
  const todaySales = sales.filter(s => !s.voided && new Date(s.created_at).toDateString() === todayStr);
  const cash = todaySales.filter(s => s.payment_method === 'cash').reduce((s2, s) => s2 + Number(s.subtotal), 0);
  const online = todaySales.filter(s => s.payment_method === 'online').reduce((s2, s) => s2 + Number(s.subtotal), 0);
  const sponsorSales = todaySales.filter(s => s.payment_method === 'sponsor');
  const revenue = cash + online; // sponsor/freebie items aren't real income, kept out of this total

  document.getElementById('statTodayTotal').textContent = peso(revenue);
  document.getElementById('statTodayCount').textContent = todaySales.length;
  document.getElementById('statSplit').textContent = `${peso(cash)} / ${peso(online)}`;
  document.getElementById('statFreebies').textContent = `${sponsorSales.length}`;

  const low = products.filter(p => p.stock <= 5).sort((a, b) => a.stock - b.stock);
  document.getElementById('statLowStock').textContent = low.length;

  const tbody = document.querySelector('#lowStockTable tbody');
  tbody.innerHTML = low.length
    ? low.map(p => `<tr><td>${p.name}</td><td>${p.category || ''}</td><td class="mono">${p.stock}</td></tr>`).join('')
    : `<tr><td colspan="3">Nothing running low.</td></tr>`;
}

// ── Size sorting (S/M/L/XL/2XL/3XL…) ───────────────────────
// Only the numeric "NXL" notation (2XL, 3XL, 10XL…) is treated as an
// extended size. "XXL"-style repeated letters are intentionally left
// unrecognized (sorted after known sizes) rather than guessed as 2XL.
function sizeSortValue(raw) {
  if (!raw) return 9999; // blanks sort last
  const s = raw.trim().toUpperCase();
  const base = ['XXS', 'XS', 'S', 'M', 'L'];
  const baseIdx = base.indexOf(s);
  if (baseIdx !== -1) return baseIdx;
  if (s === 'XL') return base.length;

  // "2XL", "3XL", "10XL"…
  const m = s.match(/^(\d+)\s*X\s*L$/);
  if (m) return base.length + (parseInt(m[1], 10) - 1);

  return 5000; // unrecognized sizes (e.g. "XXL", "One Size") sort after known sizes
}

// ── Inventory ─────────────────────────────────────────────
function sortedProducts() {
  const { key, dir } = inventorySort;
  const mult = dir === 'asc' ? 1 : -1;
  return [...products].sort((a, b) => {
    if (key === 'size') {
      const av = sizeSortValue(a.size), bv = sizeSortValue(b.size);
      if (av !== bv) return (av - bv) * mult;
      return (a.size || '').localeCompare(b.size || '') * mult;
    }
    let av = a[key], bv = b[key];
    if (key === 'price' || key === 'stock') { av = Number(av) || 0; bv = Number(bv) || 0; }
    else { av = (av || '').toString().toLowerCase(); bv = (bv || '').toString().toLowerCase(); }
    if (av < bv) return -1 * mult;
    if (av > bv) return 1 * mult;
    return 0;
  });
}

function renderInventoryTable() {
  document.querySelectorAll('#inventoryTable th.sortable').forEach(th => {
    const isActive = th.dataset.sort === inventorySort.key;
    th.classList.toggle('active', isActive);
    th.querySelector('.arrow')?.remove();
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = isActive ? (inventorySort.dir === 'asc' ? '↑' : '↓') : '↕';
    th.appendChild(arrow);
  });

  const tbody = document.querySelector('#inventoryTable tbody');
  tbody.innerHTML = sortedProducts().map(p => `
    <tr>
      <td>${p.name}</td>
      <td>${p.category || ''}</td>
      <td class="mono">${p.sku || '—'}</td>
      <td>${p.size || '—'}</td>
      <td class="mono">${peso(p.price)}</td>
      <td class="mono">${p.stock}</td>
      <td>
        <button class="icon-btn" data-edit="${p.id}">Edit</button>
        <button class="icon-btn danger" data-del="${p.id}">Delete</button>
      </td>
    </tr>
  `).join('') || `<tr><td colspan="7">No items yet — add your first one.</td></tr>`;

  tbody.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openProductModal(b.dataset.edit)));
  tbody.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => deleteProduct(b.dataset.del)));
}

document.querySelectorAll('#inventoryTable th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (inventorySort.key === key) inventorySort.dir = inventorySort.dir === 'asc' ? 'desc' : 'asc';
    else inventorySort = { key, dir: 'asc' };
    renderInventoryTable();
  });
});

function openProductModal(id) {
  const backdrop = document.getElementById('productModalBackdrop');
  const p = id ? products.find(x => x.id === id) : null;
  document.getElementById('productModalTitle').textContent = p ? 'Edit item' : 'Add item';
  document.getElementById('productId').value = p ? p.id : '';
  document.getElementById('pName').value = p ? p.name : '';
  document.getElementById('pCategory').value = p ? (p.category || '') : '';
  document.getElementById('pSku').value = p ? (p.sku || '') : '';
  document.getElementById('pSize').value = p ? (p.size || '') : '';
  document.getElementById('pPrice').value = p ? p.price : '';
  document.getElementById('pStock').value = p ? p.stock : '';
  backdrop.classList.remove('hidden');
}
document.getElementById('addProductBtn').addEventListener('click', () => openProductModal(null));
document.getElementById('cancelProductBtn').addEventListener('click', () => document.getElementById('productModalBackdrop').classList.add('hidden'));

document.getElementById('productForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!requireActor()) return;
  const id = document.getElementById('productId').value;
  const payload = {
    name: document.getElementById('pName').value.trim(),
    category: document.getElementById('pCategory').value.trim(),
    sku: document.getElementById('pSku').value.trim(),
    size: document.getElementById('pSize').value.trim(),
    price: parseFloat(document.getElementById('pPrice').value),
    stock: parseInt(document.getElementById('pStock').value, 10),
    actor_cashier_id: currentActorId,
    actor_name: currentActorName
  };
  try {
    if (id) await api(`/products/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/products', { method: 'POST', body: JSON.stringify(payload) });
    document.getElementById('productModalBackdrop').classList.add('hidden');
    toast('Item saved.');
    await loadAll();
    renderInventoryTable();
  } catch (err) {
    toast(err.message, true);
  }
});

async function deleteProduct(id) {
  if (!requireActor()) return;
  if (!confirm('Delete this item? This cannot be undone.')) return;
  try {
    await api(`/products/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ actor_cashier_id: currentActorId, actor_name: currentActorName })
    });
    toast('Item deleted.');
    await loadAll();
    renderInventoryTable();
  } catch (err) {
    toast(err.message, true);
  }
}

// ── History ───────────────────────────────────────────────
function renderHistoryTable() {
  const tbody = document.querySelector('#historyTable tbody');
  tbody.innerHTML = sales.map(s => {
    const time = new Date(s.created_at).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
    const itemsStr = (s.sale_items || [])
      .map(i => `${i.product_name}${i.product_size ? ' (' + i.product_size + ')' : ''} ×${i.quantity}`)
      .join(', ');
    let refCell = s.reference_number || '—';
    if (s.payment_method === 'sponsor') {
      refCell = `${s.sponsor_name || '—'} · ${s.sponsor_brand || '—'}<br><small>rep: ${s.sponsor_representative || '—'}</small>`;
    }
    const flags = [
      s.voided ? '<span class="badge voided">Voided</span>' : '',
      (!s.voided && s.edited) ? '<span class="badge edited">Edited</span>' : ''
    ].filter(Boolean).join(' ');

    return `
      <tr class="${s.voided ? 'row-voided' : ''}">
        <td>${time}</td>
        <td>${s.cashiers ? s.cashiers.name : '—'}</td>
        <td>${itemsStr} ${flags}</td>
        <td><span class="badge ${s.payment_method}">${s.payment_method}</span></td>
        <td class="mono">${refCell}</td>
        <td class="mono">${peso(s.subtotal)}</td>
        <td>${s.voided ? '' : `<button class="icon-btn" data-edit-sale="${s.id}">Edit</button>`}</td>
      </tr>`;
  }).join('') || `<tr><td colspan="7">No transactions yet.</td></tr>`;

  tbody.querySelectorAll('[data-edit-sale]').forEach(b => b.addEventListener('click', () => openEditSaleModal(b.dataset.editSale)));
}

// ── Edit / void a sale ──────────────────────────────────────
let editSaleState = { saleId: null, items: [] };

function openEditSaleModal(saleId) {
  const sale = sales.find(s => s.id === saleId);
  if (!sale) return;

  editSaleState.saleId = saleId;
  editSaleState.items = (sale.sale_items || []).map(i => ({
    product_id: i.product_id, name: i.product_name, size: i.product_size, qty: i.quantity, price: Number(i.unit_price ?? i.line_total / i.quantity)
  }));

  document.getElementById('editRefNumber').value = sale.reference_number || '';
  document.getElementById('editSponsorName').value = sale.sponsor_name || '';
  document.getElementById('editSponsorBrand').value = sale.sponsor_brand || '';
  document.getElementById('editSponsorRep').value = sale.sponsor_representative || '';
  document.getElementById('editReason').value = '';
  document.getElementById('editSaleError').textContent = '';

  const actorSel = document.getElementById('editActorSelect');
  const activeCashiers = cashiers.filter(c => c.active);
  actorSel.innerHTML = `<option value="">— select —</option>` + activeCashiers.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  actorSel.value = currentActorId || '';

  document.querySelectorAll('#editPayToggle .pay-opt').forEach(b => b.classList.toggle('active', b.dataset.method === sale.payment_method));
  document.getElementById('editRefField').classList.toggle('hidden', sale.payment_method !== 'online');
  document.getElementById('editSponsorFields').classList.toggle('hidden', sale.payment_method !== 'sponsor');

  renderEditSaleItems();
  document.getElementById('editSaleModalBackdrop').classList.remove('hidden');
}

function currentEditPayMethod() {
  return document.querySelector('#editPayToggle .pay-opt.active')?.dataset.method || 'cash';
}

function renderEditSaleItems() {
  const wrap = document.getElementById('editSaleItems');
  const isSponsor = currentEditPayMethod() === 'sponsor';
  const rows = editSaleState.items.map((it, idx) => `
    <div class="cart-line">
      <div class="cl-name">${it.name}${it.size ? ' · ' + it.size : ''}</div>
      <div class="cl-qty">
        <button data-idx="${idx}" data-d="-1">−</button>
        <span>${it.qty}</span>
        <button data-idx="${idx}" data-d="1">+</button>
      </div>
      <div class="cl-total">${isSponsor ? 'Free' : peso(it.price * it.qty)}</div>
      <button class="cl-remove" data-idx="${idx}" data-d="remove">×</button>
    </div>`).join('');

  const total = isSponsor ? 0 : editSaleState.items.reduce((s, i) => s + i.price * i.qty, 0);

  wrap.innerHTML = rows + `
    <div class="edit-add-item">
      <select id="editAddProductSelect">
        <option value="">+ Add a different item…</option>
        ${products.map(p => `<option value="${p.id}">${p.name}${p.size ? ' · ' + p.size : ''} (${p.stock} left)</option>`).join('')}
      </select>
    </div>
    <div class="row total"><span>New total</span><span>${peso(total)}</span></div>
  `;

  wrap.querySelectorAll('button[data-d]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      if (btn.dataset.d === 'remove') {
        editSaleState.items.splice(idx, 1);
      } else {
        editSaleState.items[idx].qty += parseInt(btn.dataset.d);
        if (editSaleState.items[idx].qty <= 0) editSaleState.items.splice(idx, 1);
      }
      renderEditSaleItems();
    });
  });

  const addSel = document.getElementById('editAddProductSelect');
  addSel.addEventListener('change', () => {
    const pid = addSel.value;
    if (!pid) return;
    const p = products.find(x => x.id === pid);
    const existing = editSaleState.items.find(i => i.product_id === pid);
    if (existing) existing.qty += 1;
    else editSaleState.items.push({ product_id: p.id, name: p.name, size: p.size, qty: 1, price: p.price });
    renderEditSaleItems();
  });
}

document.querySelectorAll('#editPayToggle .pay-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#editPayToggle .pay-opt').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('editRefField').classList.toggle('hidden', btn.dataset.method !== 'online');
    document.getElementById('editSponsorFields').classList.toggle('hidden', btn.dataset.method !== 'sponsor');
    renderEditSaleItems();
  });
});

document.getElementById('cancelEditSaleBtn').addEventListener('click', () => document.getElementById('editSaleModalBackdrop').classList.add('hidden'));

document.getElementById('saveEditSaleBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('editSaleError');
  errEl.textContent = '';

  if (!editSaleState.items.length) { errEl.textContent = 'A sale needs at least one item — use Void instead to cancel it entirely.'; return; }

  const actorSel = document.getElementById('editActorSelect');
  const actorId = actorSel.value;
  if (!actorId) { errEl.textContent = "Select who's making this change."; return; }
  const actorName = cashiers.find(c => c.id === actorId)?.name || null;

  const payMethod = document.querySelector('#editPayToggle .pay-opt.active')?.dataset.method || 'cash';
  const refNumber = document.getElementById('editRefNumber').value.trim();
  if (payMethod === 'online' && !refNumber) { errEl.textContent = 'Reference number is required for online payments.'; return; }

  const sponsorName = document.getElementById('editSponsorName').value.trim();
  const sponsorBrand = document.getElementById('editSponsorBrand').value.trim();
  const sponsorRep = document.getElementById('editSponsorRep').value.trim();
  if (payMethod === 'sponsor' && !sponsorName && !sponsorBrand && !sponsorRep) {
    errEl.textContent = 'Fill in at least one of: sponsor name, brand, or representative.';
    return;
  }

  const reason = document.getElementById('editReason').value.trim();
  if (!reason) { errEl.textContent = 'Please note a short reason for this change — it goes in the audit trail.'; return; }

  try {
    await api(`/sales/${editSaleState.saleId}`, {
      method: 'PUT',
      body: JSON.stringify({
        items: editSaleState.items.map(i => ({ product_id: i.product_id, quantity: i.qty })),
        payment_method: payMethod,
        reference_number: payMethod === 'online' ? refNumber : null,
        sponsor_name: payMethod === 'sponsor' ? sponsorName : null,
        sponsor_brand: payMethod === 'sponsor' ? sponsorBrand : null,
        sponsor_representative: payMethod === 'sponsor' ? sponsorRep : null,
        actor_cashier_id: actorId,
        actor_name: actorName,
        reason
      })
    });
    toast('Sale updated.');
    document.getElementById('editSaleModalBackdrop').classList.add('hidden');
    await loadAll();
    renderHistoryTable();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

document.getElementById('voidSaleBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('editSaleError');
  errEl.textContent = '';

  const actorSel = document.getElementById('editActorSelect');
  const actorId = actorSel.value;
  if (!actorId) { errEl.textContent = "Select who's making this change."; return; }
  const actorName = cashiers.find(c => c.id === actorId)?.name || null;

  const reason = document.getElementById('editReason').value.trim();
  if (!reason) { errEl.textContent = 'Please note a short reason for voiding this sale.'; return; }
  if (!confirm('Void this sale? Stock will be restored and it will be excluded from totals.')) return;

  try {
    await api(`/sales/${editSaleState.saleId}`, {
      method: 'PUT',
      body: JSON.stringify({ voided: true, actor_cashier_id: actorId, actor_name: actorName, reason })
    });
    toast('Sale voided.');
    document.getElementById('editSaleModalBackdrop').classList.add('hidden');
    await loadAll();
    renderHistoryTable();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

// ── Audit trail ───────────────────────────────────────────
function actionBadgeClass(action) {
  if (action.endsWith('_delete') || action === 'sale_void') return 'danger';
  if (action.endsWith('_create')) return 'success';
  return 'info';
}

function renderAuditTable() {
  const tbody = document.querySelector('#auditTable tbody');
  tbody.innerHTML = auditLog.map(a => {
    const time = new Date(a.created_at).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
    const actor = a.cashiers ? a.cashiers.name : (a.actor_name || '—');
    return `
      <tr class="row-clickable" data-audit-id="${a.id}">
        <td>${time}</td>
        <td><span class="badge ${actionBadgeClass(a.action)}">${a.action.replace(/_/g, ' ')}</span></td>
        <td>${a.entity_type}</td>
        <td>${actor}</td>
        <td>${a.summary}</td>
      </tr>`;
  }).join('') || `<tr><td colspan="5">No activity logged yet.</td></tr>`;

  tbody.querySelectorAll('[data-audit-id]').forEach(row => {
    row.addEventListener('click', () => openAuditDetailModal(row.dataset.auditId));
  });
}

// Turns the raw `details` JSON (before/after product snapshots, sale line
// items with size, etc.) into readable HTML for the detail modal.
function renderKeyValueRows(rows) {
  return rows.map(([k, v]) => `<div class="detail-row"><span>${k}</span><span>${v}</span></div>`).join('');
}

function formatProductDetailRows(a) {
  const d = a.details || {};
  const before = d.before || null;
  const after = d.after || d.new || d.deleted || {};
  const fieldLabels = { name: 'Name', category: 'Category', sku: 'SKU', size: 'Size', price: 'Price', stock: 'Stock' };
  const rows = [];
  Object.keys(fieldLabels).forEach(f => {
    if (after[f] === undefined) return;
    const label = fieldLabels[f];
    const val = f === 'price' ? (after[f] !== null ? peso(after[f]) : '—') : (after[f] ?? '—');
    if (before && before[f] !== undefined && before[f] !== after[f]) {
      const beforeVal = f === 'price' ? peso(before[f]) : (before[f] ?? '—');
      rows.push([label, `${beforeVal} → ${val}`]);
    } else {
      rows.push([label, val]);
    }
  });
  return rows;
}

function formatCashierDetailRows(a) {
  const d = a.details || {};
  const obj = d.after || d.new || {};
  return Object.entries(obj)
    .filter(([k]) => k !== 'id' && k !== 'created_at')
    .map(([k, v]) => [k, String(v)]);
}

function itemsListHTML(items) {
  if (!items || !items.length) return '<p class="empty-hint">No items.</p>';
  return items.map(it => {
    const label = it.product_name || it.name || 'Item';
    const size = it.product_size || it.size;
    const qty = it.quantity ?? it.qty ?? '—';
    const lineTotal = it.line_total !== undefined
      ? peso(it.line_total)
      : (it.price !== undefined ? peso(it.price * (it.quantity ?? it.qty ?? 0)) : '');
    return `<div class="detail-row"><span>${label}${size ? ' · ' + size : ''} ×${qty}</span><span>${lineTotal}</span></div>`;
  }).join('');
}

function formatSaleDetailHTML(a) {
  const d = a.details || {};
  let html = '';

  if (d.old_items && d.new_items) {
    html += `<h3 class="detail-section-title">Original sale</h3>${itemsListHTML(d.old_items)}`;
    html += `<h3 class="detail-section-title">Updated sale</h3>${itemsListHTML(d.new_items)}`;
  } else if (d.old_items) {
    html += `<h3 class="detail-section-title">Voided sale — items restored to stock</h3>${itemsListHTML(d.old_items)}`;
  } else if (d.items) {
    html += `<h3 class="detail-section-title">Items</h3>${itemsListHTML(d.items)}`;
  }

  const meta = [];
  if (d.payment_method) meta.push(['Payment method', d.payment_method]);
  if (d.reason) meta.push(['Reason', d.reason]);
  if (meta.length) html += `<h3 class="detail-section-title">Details</h3>${renderKeyValueRows(meta)}`;

  return html || `<pre>${JSON.stringify(d, null, 2)}</pre>`;
}

function openAuditDetailModal(auditId) {
  const a = auditLog.find(x => x.id === auditId);
  if (!a) return;

  const time = new Date(a.created_at).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
  const actor = a.cashiers ? a.cashiers.name : (a.actor_name || '—');

  document.getElementById('auditDetailTitle').textContent = a.action.replace(/_/g, ' ');
  document.getElementById('auditDetailMeta').textContent = `${time} · ${actor} · ${a.entity_type}`;

  let html;
  if (a.entity_type === 'product') {
    const rows = formatProductDetailRows(a);
    html = rows.length ? renderKeyValueRows(rows) : `<pre>${JSON.stringify(a.details || {}, null, 2)}</pre>`;
  } else if (a.entity_type === 'cashier') {
    const rows = formatCashierDetailRows(a);
    html = rows.length ? renderKeyValueRows(rows) : `<pre>${JSON.stringify(a.details || {}, null, 2)}</pre>`;
  } else if (a.entity_type === 'sale') {
    html = formatSaleDetailHTML(a);
  } else {
    html = `<pre>${JSON.stringify(a.details || {}, null, 2)}</pre>`;
  }

  document.getElementById('auditDetailRows').innerHTML = html;
  document.getElementById('auditDetailModalBackdrop').classList.remove('hidden');
}

document.getElementById('closeAuditDetailBtn').addEventListener('click', () => document.getElementById('auditDetailModalBackdrop').classList.add('hidden'));
document.getElementById('auditDetailModalBackdrop').addEventListener('click', e => {
  if (e.target.id === 'auditDetailModalBackdrop') e.currentTarget.classList.add('hidden');
});

// ── Cashiers ──────────────────────────────────────────────
function renderCashiersTable() {
  const tbody = document.querySelector('#cashiersTable tbody');
  tbody.innerHTML = cashiers.map(c => `
    <tr>
      <td>${c.name}</td>
      <td><span class="badge ${c.active ? 'active' : 'inactive'}">${c.active ? 'Active' : 'Inactive'}</span></td>
      <td><button class="icon-btn" data-toggle="${c.id}" data-active="${c.active}">${c.active ? 'Deactivate' : 'Activate'}</button></td>
    </tr>
  `).join('') || `<tr><td colspan="3">No cashiers yet — add your first one.</td></tr>`;

  tbody.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', async () => {
    try {
      await api(`/cashiers/${b.dataset.toggle}`, {
        method: 'PUT',
        body: JSON.stringify({ active: b.dataset.active !== 'true', actor_cashier_id: currentActorId, actor_name: currentActorName })
      });
      await loadAll();
      renderCashiersTable();
    } catch (err) { toast(err.message, true); }
  }));
}

document.getElementById('addCashierBtn').addEventListener('click', () => document.getElementById('cashierModalBackdrop').classList.remove('hidden'));
document.getElementById('cancelCashierBtn').addEventListener('click', () => document.getElementById('cashierModalBackdrop').classList.add('hidden'));
document.getElementById('cashierForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name = document.getElementById('cName').value.trim();
  try {
    await api('/cashiers', { method: 'POST', body: JSON.stringify({ name, actor_cashier_id: currentActorId, actor_name: currentActorName }) });
    document.getElementById('cashierModalBackdrop').classList.add('hidden');
    document.getElementById('cashierForm').reset();
    toast('Cashier added.');
    await loadAll();
    renderCashiersTable();
  } catch (err) {
    toast(err.message, true);
  }
});

// ── Init ──────────────────────────────────────────────────
loadAll();