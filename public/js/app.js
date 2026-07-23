const API = '/api';
const peso = n => '₱' + Number(n).toFixed(2);

let products = [];
let cashiers = [];
let sales = [];
let cart = [];              // [{product_id, name, sku, price, stock, qty}]
let activeCategory = 'All';
let paymentMethod = 'cash';
let searchTerm = '';
let inventorySort = { key: 'name', dir: 'asc' };

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
  if (view === 'cashiers') renderCashiersTable();
}

// ── Load everything ───────────────────────────────────────
async function loadAll() {
  try {
    [products, cashiers, sales] = await Promise.all([
      api('/products'),
      api('/cashiers'),
      api('/sales')
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

function renderGrid() {
  const grid = document.getElementById('posGrid');
  const term = searchTerm.trim().toLowerCase();
  const list = products.filter(p => {
    const matchesCat = activeCategory === 'All' || (p.category || 'Uncategorized') === activeCategory;
    const matchesSearch = !term || p.name.toLowerCase().includes(term) || (p.sku || '').toLowerCase().includes(term);
    return matchesCat && matchesSearch;
  });

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
  });
}

document.getElementById('posSearch').addEventListener('input', e => {
  searchTerm = e.target.value;
  renderGrid();
});

// ── Cart ──────────────────────────────────────────────────
function addToCart(productId) {
  const p = products.find(x => x.id === productId);
  if (!p) return;
  const line = cart.find(c => c.product_id === productId);
  const currentQty = line ? line.qty : 0;
  if (currentQty >= p.stock) { toast(`Only ${p.stock} of "${p.name}" in stock.`, true); return; }
  if (line) line.qty++;
  else cart.push({ product_id: p.id, name: p.name, sku: p.sku, price: p.price, stock: p.stock, qty: 1 });
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
  if (!cart.length) {
    wrap.innerHTML = `<p class="empty-hint">Cart is empty — add something from the grid.</p>`;
  } else {
    wrap.innerHTML = cart.map(c => `
      <div class="cart-line">
        <div class="cl-name">${c.name}<small>${c.sku || ''}</small></div>
        <div class="cl-qty">
          <button data-id="${c.product_id}" data-d="-1">−</button>
          <span>${c.qty}</span>
          <button data-id="${c.product_id}" data-d="1">+</button>
        </div>
        <div class="cl-total">${peso(c.price * c.qty)}</div>
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
  const total = cart.reduce((sum, c) => sum + c.price * c.qty, 0);
  document.getElementById('cartTotal').textContent = peso(total);
}

document.getElementById('clearCartBtn').addEventListener('click', () => {
  cart = [];
  renderCart();
  renderGrid();
});

// ── Payment method ────────────────────────────────────────
document.querySelectorAll('.pay-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    paymentMethod = btn.dataset.method;
    document.querySelectorAll('.pay-opt').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('refField').classList.toggle('hidden', paymentMethod !== 'online');
    document.getElementById('sponsorFields').classList.toggle('hidden', paymentMethod !== 'sponsor');
  });
});

// ── Cashier select ────────────────────────────────────────
function renderCashierSelect() {
  const sel = document.getElementById('cashierSelect');
  const active = cashiers.filter(c => c.active);
  sel.innerHTML = active.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  updateActiveCashierPill();
  sel.addEventListener('change', updateActiveCashierPill);
}
function updateActiveCashierPill() {
  const sel = document.getElementById('cashierSelect');
  const opt = sel.options[sel.selectedIndex];
  document.getElementById('activeCashierName').textContent = opt ? opt.textContent : '— none —';
}

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
  if (paymentMethod === 'sponsor' && (!sponsorName || !sponsorBrand || !sponsorRep)) {
    errEl.textContent = 'Sponsor name, brand, and representative are all required.';
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
  const todaySales = sales.filter(s => new Date(s.created_at).toDateString() === todayStr);
  const cash = todaySales.filter(s => s.payment_method === 'cash').reduce((s2, s) => s2 + Number(s.subtotal), 0);
  const online = todaySales.filter(s => s.payment_method === 'online').reduce((s2, s) => s2 + Number(s.subtotal), 0);
  const sponsorSales = todaySales.filter(s => s.payment_method === 'sponsor');
  const sponsorValue = sponsorSales.reduce((s2, s) => s2 + Number(s.subtotal), 0);
  const revenue = cash + online; // sponsor/freebie items aren't real income, kept out of this total

  document.getElementById('statTodayTotal').textContent = peso(revenue);
  document.getElementById('statTodayCount').textContent = todaySales.length;
  document.getElementById('statSplit').textContent = `${peso(cash)} / ${peso(online)}`;
  document.getElementById('statFreebies').textContent = `${sponsorSales.length} · ${peso(sponsorValue)}`;

  const low = products.filter(p => p.stock <= 5).sort((a, b) => a.stock - b.stock);
  document.getElementById('statLowStock').textContent = low.length;

  const tbody = document.querySelector('#lowStockTable tbody');
  tbody.innerHTML = low.length
    ? low.map(p => `<tr><td>${p.name}</td><td>${p.category || ''}</td><td class="mono">${p.stock}</td></tr>`).join('')
    : `<tr><td colspan="3">Nothing running low.</td></tr>`;
}

// ── Inventory ─────────────────────────────────────────────
function sortedProducts() {
  const { key, dir } = inventorySort;
  const mult = dir === 'asc' ? 1 : -1;
  return [...products].sort((a, b) => {
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
  const id = document.getElementById('productId').value;
  const payload = {
    name: document.getElementById('pName').value.trim(),
    category: document.getElementById('pCategory').value.trim(),
    sku: document.getElementById('pSku').value.trim(),
    size: document.getElementById('pSize').value.trim(),
    price: parseFloat(document.getElementById('pPrice').value),
    stock: parseInt(document.getElementById('pStock').value, 10)
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
  if (!confirm('Delete this item? This cannot be undone.')) return;
  try {
    await api(`/products/${id}`, { method: 'DELETE' });
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
    const itemsStr = (s.sale_items || []).map(i => `${i.product_name} ×${i.quantity}`).join(', ');
    let refCell = s.reference_number || '—';
    if (s.payment_method === 'sponsor') {
      refCell = `${s.sponsor_name || '—'} · ${s.sponsor_brand || '—'}<br><small>rep: ${s.sponsor_representative || '—'}</small>`;
    }
    return `
      <tr>
        <td>${time}</td>
        <td>${s.cashiers ? s.cashiers.name : '—'}</td>
        <td>${itemsStr}</td>
        <td><span class="badge ${s.payment_method}">${s.payment_method}</span></td>
        <td class="mono">${refCell}</td>
        <td class="mono">${peso(s.subtotal)}</td>
      </tr>`;
  }).join('') || `<tr><td colspan="6">No transactions yet.</td></tr>`;
}

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
      await api(`/cashiers/${b.dataset.toggle}`, { method: 'PUT', body: JSON.stringify({ active: b.dataset.active !== 'true' }) });
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
    await api('/cashiers', { method: 'POST', body: JSON.stringify({ name }) });
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