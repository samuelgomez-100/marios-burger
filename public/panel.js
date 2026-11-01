const ARS = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
const money = (n) => ARS.format(n);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = (sel) => document.querySelector(sel);

const POLL_MS = 5000;
const FRESH_MS = 20_000; // cuánto tiempo se destaca un pedido recién llegado
const STATUSES = ['nuevo', 'preparando', 'listo'];
const NEXT = { nuevo: 'preparando', preparando: 'listo' };
const PREV = { preparando: 'nuevo', listo: 'preparando' };
const ACTION_LABEL = { nuevo: '👨‍🍳 Empezar a preparar', preparando: '✅ Marcar listo' };

const state = {
  orders: [],
  loaded: false,
  seen: new Set(),
  freshUntil: new Map(), // id -> timestamp
  pending: new Map(), // id -> status (cambios optimistas todavía no confirmados)
  sound: false,
  lastChange: 0, // para ignorar polls que salieron antes de un cambio de estado
};

// ---------- Clave del panel ----------

const KEY_STORE = 'marios-panel-key';
let panelKey = '';
try {
  panelKey = localStorage.getItem(KEY_STORE) ?? '';
} catch {
  // sin storage: se pide la clave en cada visita
}

function showLogin() {
  const dialog = $('#login');
  if (!dialog.open) {
    dialog.showModal();
    $('#login-key').focus();
  }
}

// fetch con la clave del panel; si el server la rechaza, pide la clave.
async function panelFetch(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { ...options.headers, 'X-Panel-Key': encodeURIComponent(panelKey) } });
  if (res.status === 401) {
    showLogin();
    throw Object.assign(new Error('Necesitás la clave del panel.'), { code: 'auth' });
  }
  return res;
}

let toastTimer;
function showToast(text, isError = false) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

function beep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
  } catch {
    // sin audio, no pasa nada
  }
}

const clock = (iso) => new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

function ago(iso) {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  return `hace ${Math.floor(min / 60)} h ${min % 60} min`;
}

function orderCard(order) {
  const status = state.pending.get(order.id) ?? order.status;
  const fresh = (state.freshUntil.get(order.id) ?? 0) > Date.now();
  const mode =
    order.mode === 'envio'
      ? `<span class="pill envio">🛵 Envío</span> ${esc(order.address)}${order.addressDetails ? `<span class="notes">📍 ${esc(order.addressDetails)}</span>` : ''}`
      : '<span class="pill retiro">🏃 Retira en el local</span>';
  const items = order.items
    .map(
      (l) => `<li><span><strong>${l.qty}×</strong> ${esc(l.name)}${l.notes ? `<span class="notes">${esc(l.notes)}</span>` : ''}</span><span>${money(l.subtotal)}</span></li>`,
    )
    .join('');
  const actions = [
    NEXT[status] ? `<button class="btn" type="button" data-id="${order.id}" data-to="${NEXT[status]}">${ACTION_LABEL[status]}</button>` : '',
    PREV[status] ? `<button class="btn btn-ghost btn-sm" type="button" data-id="${order.id}" data-to="${PREV[status]}" title="Volver al estado anterior">↩ Volver</button>` : '',
  ].join('');

  return `<article class="card order${fresh ? ' fresh' : ''}" data-status="${status}">
    <div class="order-head">
      <span class="order-id">#${order.id} ${fresh ? '<span class="pill new">NUEVO</span>' : ''}</span>
      <span class="order-time">Llegó ${clock(order.createdAt)}<br>${ago(order.createdAt)}</span>
    </div>
    <div class="order-customer">${esc(order.customerName)}${order.source === 'whatsapp' ? ' <span class="pill whatsapp">💬 WhatsApp</span>' : ''}</div>
    <div class="order-meta">
      <div>📞 <a href="tel:${esc((order.phone ?? '').replace(/[^\d+]/g, ''))}">${esc(order.phone)}</a>${order.email ? ` · ✉️ <a href="mailto:${esc(order.email)}">${esc(order.email)}</a>` : ''}</div>
      <div>${mode}</div>
      <div>🕘 Para: <strong>${esc(order.time)}</strong></div>
    </div>
    <ul class="order-items">${items}</ul>
    ${order.deliveryFee ? `<div class="order-meta"><div>Envío ${money(order.deliveryFee)}</div></div>` : ''}
    <div class="order-total"><span>Total</span><span>${money(order.total)}</span></div>
    ${actions ? `<div class="order-actions">${actions}</div>` : ''}
  </article>`;
}

function render() {
  const groups = Object.fromEntries(STATUSES.map((s) => [s, []]));
  for (const order of state.orders) groups[state.pending.get(order.id) ?? order.status]?.push(order);

  const empty = {
    nuevo: 'Todavía no entraron pedidos. Aparecen solos acá 👀',
    preparando: 'Nada en preparación.',
    listo: 'Nada listo todavía.',
  };
  for (const status of STATUSES) {
    // Los más viejos primero en preparación/listos; los nuevos, también por orden de llegada (FIFO de cocina).
    const list = groups[status].sort((a, b) => a.id - b.id);
    $(`#list-${status}`).innerHTML = list.length ? list.map(orderCard).join('') : `<div class="column-empty">${empty[status]}</div>`;
    $(`#count-${status}`).textContent = list.length;
    $(`#count-tab-${status}`).textContent = list.length;
  }
  const nuevos = groups.nuevo.length;
  document.title = `${nuevos ? `(${nuevos}) ` : ''}Panel · Mario's`;
}

async function fetchOrders() {
  const startedAt = Date.now();
  try {
    const res = await panelFetch('/api/orders', { cache: 'no-store' });
    if (!res.ok) throw new Error(`Error ${res.status}`);
    const orders = await res.json();

    const arrivals = orders.filter((o) => !state.seen.has(o.id));
    for (const o of arrivals) {
      state.seen.add(o.id);
      if (state.loaded) state.freshUntil.set(o.id, Date.now() + FRESH_MS);
    }
    if (state.loaded && arrivals.length) {
      showToast(arrivals.length === 1 ? `Entró el pedido #${arrivals[0].id}` : `Entraron ${arrivals.length} pedidos`);
      if (state.sound) beep();
    }

    if (startedAt >= state.lastChange) state.orders = orders;
    state.loaded = true;
    $('#panel-error').hidden = true;
    $('#live').classList.remove('offline');
    $('#live').textContent = `En vivo · actualizado ${new Date().toLocaleTimeString('es-AR')}`;
    render();
  } catch (err) {
    $('#live').classList.add('offline');
    if (err.code === 'auth') {
      $('#live').textContent = 'Esperando la clave';
      return;
    }
    $('#live').textContent = 'Sin conexión';
    $('#panel-error').textContent = 'No pudimos conectarnos con el server. Reintentamos solos cada 5 segundos…';
    $('#panel-error').hidden = false;
    if (!state.loaded) {
      for (const s of STATUSES) $(`#list-${s}`).innerHTML = '';
    }
  }
}

async function poll() {
  await fetchOrders();
  setTimeout(poll, POLL_MS);
}

async function changeStatus(id, status) {
  state.pending.set(id, status);
  state.freshUntil.delete(id);
  render();
  try {
    const res = await panelFetch(`/api/orders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    const i = state.orders.findIndex((o) => o.id === id);
    if (i >= 0) state.orders[i] = data;
  } catch (err) {
    showToast(`No se pudo actualizar #${id}: ${err.message}`, true);
  } finally {
    state.pending.delete(id);
    state.lastChange = Date.now();
    render();
  }
}

$('#board').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-to]');
  if (btn) changeStatus(Number(btn.dataset.id), btn.dataset.to);
});

for (const btn of document.querySelectorAll('[data-show]')) {
  btn.addEventListener('click', () => {
    $('#board').dataset.active = btn.dataset.show;
    for (const b of document.querySelectorAll('[data-show]')) b.setAttribute('aria-pressed', String(b === btn));
  });
}

$('#sound-btn').addEventListener('click', () => {
  state.sound = !state.sound;
  $('#sound-btn').textContent = state.sound ? '🔔 Sonido' : '🔕 Sonido';
  $('#sound-btn').setAttribute('aria-pressed', String(state.sound));
  if (state.sound) beep();
});

// ---------- Pedido manual (WhatsApp / teléfono) ----------

const manual = { menu: null, items: [], mode: 'retiro' };
const productById = (id) => manual.menu?.products.find((p) => p.id === id);

async function openManual() {
  $('#m-error').hidden = true;
  if (!manual.menu) {
    try {
      const res = await fetch('/api/menu');
      if (!res.ok) throw new Error();
      manual.menu = await res.json();
    } catch {
      showToast('No pudimos cargar el menú. Probá de nuevo.', true);
      return;
    }
    $('#m-product').innerHTML = manual.menu.categories
      .map((cat) => {
        const options = manual.menu.products
          .filter((p) => p.category === cat)
          .map((p) => `<option value="${esc(p.id)}" ${p.available ? '' : 'disabled'}>${esc(p.name)} · ${money(p.price)}${p.available ? '' : ' (sin stock)'}</option>`)
          .join('');
        return `<optgroup label="${esc(cat)}">${options}</optgroup>`;
      })
      .join('');
    $('#m-product').value = manual.menu.products.find((p) => p.available)?.id ?? '';
    syncVariant();
  }
  renderManual();
  $('#manual').showModal();
}

function syncVariant() {
  const product = productById($('#m-product').value);
  $('#m-variant-field').hidden = !product?.variants;
  if (product?.variants) {
    $('#m-variant-label').textContent = product.variants.label;
    $('#m-variant').innerHTML = product.variants.options.map((o) => `<option>${esc(o)}</option>`).join('');
  }
}

function addManualItem() {
  const product = productById($('#m-product').value);
  if (!product?.available) return;
  const qty = Math.min(Math.max(Math.floor(Number($('#m-qty').value) || 1), 1), 50);
  const notes = [product.variants ? $('#m-variant').value : '', $('#m-notes').value.trim()].filter(Boolean).join(', ');
  manual.items.push({ id: product.id, qty, notes });
  $('#m-qty').value = 1;
  $('#m-notes').value = '';
  renderManual();
}

function renderManual() {
  $('#m-lines').innerHTML = manual.items.length
    ? manual.items
        .map((item, i) => {
          const p = productById(item.id);
          return `<li class="line">
            <div><div class="line-name">${item.qty}× ${esc(p.name)}</div>${item.notes ? `<div class="line-notes">${esc(item.notes)}</div>` : ''}</div>
            <div class="line-sub">${money(p.price * item.qty)} <button class="icon-btn" type="button" data-m-remove="${i}" aria-label="Quitar">✕</button></div>
          </li>`;
        })
        .join('')
    : '<li class="hint">Todavía no agregaste productos.</li>';

  for (const b of document.querySelectorAll('[data-m-mode]')) {
    b.setAttribute('aria-pressed', String(b.dataset.mMode === manual.mode));
  }
  $('#m-address-field').hidden = manual.mode !== 'envio';
  $('#m-details-field').hidden = manual.mode !== 'envio';

  // Total estimado; el server lo recalcula igual desde el menú.
  const subtotal = manual.items.reduce((sum, item) => sum + productById(item.id).price * item.qty, 0);
  const fee = manual.mode === 'envio' && subtotal ? manual.menu.local.deliveryFee : 0;
  $('#m-total').innerHTML = `${money(subtotal + fee)}${fee ? `<small>incluye envío ${money(fee)}</small>` : ''}`;
}

function closeManual() {
  $('#manual').close();
}

function resetManual() {
  manual.items = [];
  manual.mode = 'retiro';
  $('#manual-form').reset();
  $('#m-qty').value = 1;
  $('#m-product').value = manual.menu.products.find((p) => p.available)?.id ?? '';
  syncVariant();
  renderManual();
}

async function submitManual(e) {
  e.preventDefault();
  const errorBox = $('#m-error');
  errorBox.hidden = true;
  $('#m-submit').disabled = true;
  $('#m-submit').textContent = 'Cargando…';
  try {
    const cart = {
      items: manual.items,
      customerName: $('#m-name').value,
      phone: $('#m-phone').value,
      mode: manual.mode,
      address: $('#m-address').value,
      addressDetails: $('#m-details').value,
      time: $('#m-time').value,
    };
    const res = await panelFetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cart, source: 'whatsapp' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);

    state.seen.add(data.id); // ya lo cargó el dueño: no hace falta avisarle que "entró"
    state.orders.unshift(data);
    render();
    showToast(`Pedido #${data.id} cargado`);
    resetManual();
    closeManual();
  } catch (err) {
    errorBox.textContent = err instanceof TypeError ? 'No hay conexión con el server.' : err.message;
    errorBox.hidden = false;
  } finally {
    $('#m-submit').disabled = false;
    $('#m-submit').textContent = 'Cargar pedido';
  }
}

$('#manual-open').addEventListener('click', openManual);
$('#manual-close').addEventListener('click', closeManual);
$('#manual-cancel').addEventListener('click', closeManual);
$('#m-product').addEventListener('change', syncVariant);
$('#m-add').addEventListener('click', addManualItem);
for (const id of ['#m-qty', '#m-notes']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addManualItem();
    }
  });
}
$('#manual-form').addEventListener('submit', submitManual);
$('#manual-form').addEventListener('click', (e) => {
  const mode = e.target.closest('[data-m-mode]');
  if (mode) {
    manual.mode = mode.dataset.mMode;
    renderManual();
  }
  const remove = e.target.closest('[data-m-remove]');
  if (remove) {
    manual.items.splice(Number(remove.dataset.mRemove), 1);
    renderManual();
  }
});

// ---------- Login ----------

$('#login').addEventListener('cancel', (e) => e.preventDefault()); // sin clave no se cierra con Esc
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  panelKey = $('#login-key').value;
  $('#login-error').hidden = true;
  $('#login-btn').disabled = true;
  try {
    const res = await panelFetch('/api/orders', { cache: 'no-store' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Error ${res.status}`);
    }
    try {
      localStorage.setItem(KEY_STORE, panelKey);
    } catch {
      // nada
    }
    $('#login').close();
    $('#login-form').reset();
    fetchOrders();
  } catch (err) {
    $('#login-error').textContent = err.code === 'auth' ? 'Clave incorrecta.' : err.message;
    $('#login-error').hidden = false;
  } finally {
    $('#login-btn').disabled = false;
  }
});

// ---------- Menú y stock ----------

function adminRow(p) {
  return `<div class="admin-row${p.available ? '' : ' off'}" data-id="${esc(p.id)}">
    <div class="admin-name">
      <strong>${esc(p.name)}</strong>
      ${p.available ? '' : '<span class="badge out">Sin stock</span>'}
    </div>
    <label class="switch">
      <input type="checkbox" data-stock ${p.available ? 'checked' : ''} aria-label="Hay stock de ${esc(p.name)}">
      <span class="switch-track" aria-hidden="true"></span>
      <span class="switch-label">${p.available ? 'Hay' : 'No hay'}</span>
    </label>
    <label class="admin-price">
      <span>$</span>
      <input type="number" min="1" step="1" inputmode="numeric" value="${p.price}" data-price data-original="${p.price}" aria-label="Precio de ${esc(p.name)}">
    </label>
  </div>`;
}

async function loadAdmin() {
  const box = $('#admin-menu');
  try {
    const res = await fetch('/api/menu', { cache: 'no-store' });
    if (!res.ok) throw new Error();
    const menu = await res.json();
    box.innerHTML = menu.categories
      .map((cat) => {
        const rows = menu.products.filter((p) => p.category === cat).map(adminRow).join('');
        return rows ? `<div class="admin-group"><h3>${esc(cat)}</h3>${rows}</div>` : '';
      })
      .join('');
  } catch {
    box.innerHTML = `<div class="form-error">No pudimos cargar el menú.
      <button class="btn btn-sm" type="button" data-admin-retry style="margin-left:8px">Reintentar</button></div>`;
  }
}

async function updateProduct(id, change) {
  const res = await panelFetch(`/api/menu/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(change),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  manual.menu = null; // el pedido manual vuelve a leer el menú actualizado
  if (data.warning) showToast(data.warning, true);
  return data.product;
}

$('#admin-menu').addEventListener('change', async (e) => {
  const input = e.target;
  const row = input.closest('.admin-row');
  if (!row) return;
  const { id } = row.dataset;

  if (input.matches('[data-stock]')) {
    input.disabled = true;
    try {
      const product = await updateProduct(id, { available: input.checked });
      row.outerHTML = adminRow(product);
      showToast(`${product.name}: ${product.available ? 'hay stock' : 'sin stock'}`);
    } catch (err) {
      input.checked = !input.checked;
      input.disabled = false;
      showToast(err.message, true);
    }
  } else if (input.matches('[data-price]')) {
    const price = Number(input.value);
    if (String(price) === input.dataset.original) return;
    try {
      const product = await updateProduct(id, { price });
      input.dataset.original = String(product.price);
      showToast(`${product.name}: ahora ${money(product.price)}`);
    } catch (err) {
      input.value = input.dataset.original;
      showToast(err.message, true);
    }
  }
});
$('#admin-menu').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[data-price]')) e.target.blur(); // Enter guarda
});
$('#admin-menu').addEventListener('click', (e) => {
  if (e.target.closest('[data-admin-retry]')) loadAdmin();
});

for (const btn of document.querySelectorAll('[data-view]')) {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    $('#view-orders').hidden = view !== 'orders';
    $('#view-admin').hidden = view !== 'admin';
    for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b === btn));
    if (view === 'admin') loadAdmin();
  });
}

poll();
