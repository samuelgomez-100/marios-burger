const ARS = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
const money = (n) => ARS.format(n);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = (sel) => document.querySelector(sel);
const normalize = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const MAX_MESSAGES = 30; // mismo tope que el server
const GREETING =
  '¡Hola! 👋 Soy el asistente de Mario\'s. Decime qué querés pedir (por ej. "2 lomitos completos y una coca") o preguntame lo que necesites del menú.';
const EXAMPLES = [
  'holaa buenas!! queria 2 milas napo con fritas y una coca grande, ah y 3 empanadas de carne. paso a buscar tipo 21hs, soy lucia',
  'che tenes lomito?? mandame 1 completo sin huevo y unas papas cheddar, y una birra. es envio a belgrano 1234 3B',
  'buenas, 2 hamburguesas veggie y una doble cheddar + 2 cocas chicas, a nombre de Martín, lo antes posible',
  'cuanto sale la mila napo? y a que hora cierran? quiero 1 con... y 6 empanadas 3 de pollo 3 jyq',
];

const emptyCart = () => ({
  items: [],
  customerName: '',
  phone: '',
  email: '',
  mode: null,
  address: '',
  addressDetails: '',
  time: '',
});

const state = {
  menu: null,
  productsById: new Map(),
  cart: emptyCart(), // lo que manda el cliente: items [{id, qty, notes}] + datos
  quote: null, // lo que calculó el server (precios, total, faltantes)
  messages: [],
  sending: false,
  confirming: false,
  exampleIndex: 0,
};

// ---------- API ----------

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw Object.assign(new Error('No hay conexión con el server. Revisá tu internet y probá de nuevo.'), { code: 'network' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || `Error ${res.status}`), { code: data.code, status: res.status, data });
  }
  return data;
}

// ---------- UI general ----------

let toastTimer;
function showToast(text, isError = false) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function showTab(name) {
  for (const tab of ['chat', 'menu', 'orders']) {
    $(`#tab-${tab}`).setAttribute('aria-selected', String(tab === name));
    $(`#view-${tab}`).hidden = tab !== name;
  }
  if (name === 'chat') scrollChat();
  if (name === 'orders') loadMyOrders();
}

// ---------- Menú ----------

async function loadMenu() {
  const view = $('#view-menu');
  try {
    state.menu = await api('/api/menu');
    state.productsById = new Map(state.menu.products.map((p) => [p.id, p]));
    $('#local-info').textContent = state.menu.local.hours;
    renderMenu();
    renderCart();
  } catch (err) {
    view.innerHTML = `<div class="form-error">No pudimos cargar el menú. ${esc(err.message)}<br><button class="btn btn-sm" type="button" id="retry-menu" style="margin-top:8px">Reintentar</button></div>`;
    $('#retry-menu').addEventListener('click', loadMenu);
  }
}

function renderMenu() {
  const { categories, products } = state.menu;
  $('#view-menu').innerHTML = categories
    .map((cat) => {
      const items = products.filter((p) => p.category === cat);
      if (!items.length) return '';
      return `<section><h2>${esc(cat)}</h2><div class="menu-grid">${items.map(productCard).join('')}</div></section>`;
    })
    .join('');
}

function productCard(p) {
  const out = !p.available;
  const select =
    p.variants && !out
      ? `<label class="sr-only" for="v-${esc(p.id)}">${esc(p.variants.label)}</label>
         <select id="v-${esc(p.id)}" data-variant-for="${esc(p.id)}">
           ${p.variants.options.map((o) => `<option value="${esc(o)}">${esc(p.variants.label)}: ${esc(o)}</option>`).join('')}
         </select>`
      : '';
  return `<article class="product${out ? ' out' : ''}">
    <div class="product-head"><span class="product-name">${esc(p.name)}</span><span class="product-price">${money(p.price)}</span></div>
    <p class="product-desc">${esc(p.description)}</p>
    <div class="product-actions">
      ${out ? '<span class="badge out">Sin stock</span>' : ''}
      ${select}
      <button class="icon-btn add" type="button" data-add="${esc(p.id)}" aria-label="Agregar ${esc(p.name)}" ${out ? 'disabled' : ''}>+</button>
    </div>
  </article>`;
}

function addItem(id, notes = '') {
  const product = state.productsById.get(id);
  if (!product?.available) return;
  const line = state.cart.items.find((l) => l.id === id && normalize(l.notes) === normalize(notes));
  if (line) line.qty += 1;
  else state.cart.items.push({ id, qty: 1, notes });
  showToast(`Sumado: ${product.name}${notes ? ` (${notes})` : ''}`);
  requote();
}

// ---------- Carrito ----------

function mountCart() {
  $('#cart').innerHTML = `
    <div id="cart-order">
      <h2>Tu pedido</h2>
      <div id="cart-items"></div>
      <div id="cart-totals" class="totals"></div>
      <div class="fields">
        <div class="field" data-field="customerName">
          <label for="f-name">Nombre</label>
          <input id="f-name" name="customerName" maxlength="60" placeholder="¿A nombre de quién?" autocomplete="given-name">
        </div>
        <div class="field" data-field="phone">
          <label for="f-phone">Teléfono</label>
          <input id="f-phone" name="phone" type="tel" maxlength="30" placeholder="Ej: 11 5555-1234" autocomplete="tel" inputmode="tel">
        </div>
        <div class="field" data-field="email">
          <label for="f-email">Email (opcional)</label>
          <input id="f-email" name="email" type="email" maxlength="80" placeholder="nombre@mail.com" autocomplete="email" inputmode="email">
        </div>
        <div class="field" data-field="mode">
          <span class="label">¿Retirás o te lo llevamos?</span>
          <div class="segmented">
            <button type="button" data-mode="retiro" aria-pressed="false">🏃 Retiro</button>
            <button type="button" data-mode="envio" aria-pressed="false">🛵 Envío</button>
          </div>
        </div>
        <div class="field" data-field="address" hidden>
          <label for="f-address">Dirección de envío</label>
          <input id="f-address" name="address" maxlength="120" placeholder="Calle y número" autocomplete="street-address">
        </div>
        <div class="field" data-field="addressDetails" hidden>
          <label for="f-address-details">Más detalles (opcional)</label>
          <input id="f-address-details" name="addressDetails" maxlength="160" placeholder="Entre calles, piso/depto, timbre, color de la puerta…">
        </div>
        <div class="field" data-field="time">
          <label for="f-time">Horario</label>
          <input id="f-time" name="time" maxlength="40" placeholder="Ej: 21:30 o lo antes posible">
        </div>
      </div>
      <div id="missing-box" class="missing-box" hidden></div>
      <div id="form-error" class="form-error" hidden></div>
      <button class="btn btn-block" id="confirm-btn" type="button" disabled>Confirmar pedido</button>
    </div>
    <div id="cart-success" class="success" hidden></div>`;

  for (const input of $('#cart').querySelectorAll('input')) {
    input.addEventListener('input', () => {
      state.cart[input.name] = input.value;
      scheduleQuote();
    });
  }
  $('#cart').addEventListener('click', onCartClick);
}

function onCartClick(e) {
  const btn = e.target.closest('button');
  if (!btn) return;
  const items = state.cart.items;
  if (btn.dataset.mode) {
    state.cart.mode = btn.dataset.mode;
    renderCart();
    requote();
    if (btn.dataset.mode === 'envio') $('#f-address').focus();
  } else if (btn.dataset.inc) {
    items[Number(btn.dataset.inc)].qty += 1;
    requote();
  } else if (btn.dataset.dec) {
    const i = Number(btn.dataset.dec);
    items[i].qty -= 1;
    if (items[i].qty < 1) items.splice(i, 1);
    requote();
  } else if (btn.dataset.pick) {
    const line = items[Number(btn.dataset.pick)];
    line.notes = line.notes ? `${btn.dataset.option}, ${line.notes}` : btn.dataset.option;
    requote();
  } else if (btn.id === 'confirm-btn') {
    confirmOrder();
  } else if (btn.id === 'new-order') {
    resetAll();
  } else if (btn.id === 'track-order') {
    showTab('orders');
    $('#view-orders').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

let quoteSeq = 0;
let quoteTimer;
function scheduleQuote() {
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(requote, 250);
}

async function requote() {
  clearTimeout(quoteTimer);
  const seq = ++quoteSeq;
  try {
    const quote = await api('/api/quote', { method: 'POST', body: { cart: state.cart } });
    if (seq === quoteSeq) applyQuote(quote);
  } catch (err) {
    if (seq === quoteSeq) showToast(err.message, true);
  }
}

function applyQuote(quote) {
  state.quote = quote;
  state.cart.items = quote.items.map(({ id, qty, notes }) => ({ id, qty, notes }));
  renderCart();
}

// Copia a los inputs los datos que vinieron de la IA (o de un reset).
function syncForm() {
  $('#f-name').value = state.cart.customerName ?? '';
  $('#f-phone').value = state.cart.phone ?? '';
  $('#f-email').value = state.cart.email ?? '';
  $('#f-address').value = state.cart.address ?? '';
  $('#f-address-details').value = state.cart.addressDetails ?? '';
  $('#f-time').value = state.cart.time ?? '';
}

function lineHtml(line, i, variantMissing) {
  const product = state.productsById.get(line.id);
  const pick =
    variantMissing && product?.variants
      ? `<div class="variant-pick">Elegí ${esc(product.variants.label.toLowerCase())}:
          ${product.variants.options
            .map((o) => `<button type="button" class="chip" data-pick="${i}" data-option="${esc(o)}">${esc(o)}</button>`)
            .join('')}</div>`
      : '';
  return `<li class="line${variantMissing ? ' is-missing' : ''}">
    <div>
      <div class="line-name">${esc(line.name)}</div>
      ${line.notes ? `<div class="line-notes">${esc(line.notes)}</div>` : ''}
    </div>
    <div class="line-sub">${money(line.subtotal)}</div>
    <div class="line-controls">
      <button class="icon-btn" type="button" data-dec="${i}" aria-label="Quitar uno de ${esc(line.name)}">−</button>
      <span class="qty">${line.qty}</span>
      <button class="icon-btn" type="button" data-inc="${i}" aria-label="Sumar uno de ${esc(line.name)}">+</button>
    </div>
    <div class="line-notes" style="text-align:right">${money(line.unitPrice)} c/u</div>
    ${pick}
  </li>`;
}

function renderCart() {
  if (!$('#cart-items')) return;
  const q = state.quote ?? { items: [], subtotal: 0, deliveryFee: 0, total: 0, missing: [], ready: false };
  const hasItems = q.items.length > 0;
  // Resaltamos lo que falta recién cuando hay algo en el carrito, para no gritarle al cliente de entrada.
  const missing = hasItems ? q.missing : [];
  const missingFields = new Set(missing.map((m) => m.field));
  const missingLines = new Set(missing.filter((m) => m.field === 'variant').map((m) => m.index));

  $('#cart-items').innerHTML = hasItems
    ? `<ul class="lines">${q.items.map((l, i) => lineHtml(l, i, missingLines.has(i))).join('')}</ul>`
    : `<div class="empty"><span class="emoji">🛒</span>Todavía no hay nada. Contale al chat qué querés o sumá productos desde el menú.</div>`;

  const totals = $('#cart-totals');
  totals.hidden = !hasItems;
  totals.innerHTML = hasItems
    ? `<div><span>Subtotal</span><span>${money(q.subtotal)}</span></div>
       ${q.deliveryFee ? `<div><span>Envío</span><span>${money(q.deliveryFee)}</span></div>` : ''}
       <div class="grand"><span>Total</span><span>${money(q.total)}</span></div>`
    : '';

  for (const field of $('#cart').querySelectorAll('.field')) {
    field.classList.toggle('is-missing', missingFields.has(field.dataset.field));
  }
  for (const b of $('#cart').querySelectorAll('[data-mode]')) {
    b.setAttribute('aria-pressed', String(state.cart.mode === b.dataset.mode));
  }
  $('[data-field="address"]').hidden = state.cart.mode !== 'envio';
  $('[data-field="addressDetails"]').hidden = state.cart.mode !== 'envio';

  const box = $('#missing-box');
  box.hidden = missing.length === 0;
  box.innerHTML = `<strong>Para confirmar falta:</strong><ul>${missing.map((m) => `<li>${esc(m.label)}</li>`).join('')}</ul>`;

  const confirm = $('#confirm-btn');
  confirm.disabled = !q.ready || state.confirming;
  confirm.textContent = state.confirming ? 'Enviando…' : q.ready ? `Confirmar pedido · ${money(q.total)}` : 'Confirmar pedido';

  const count = q.items.reduce((n, l) => n + l.qty, 0);
  $('#mobile-bar').hidden = !hasItems || !$('#cart-success').hidden;
  $('#mobile-bar-text').textContent = `${count} ${count === 1 ? 'producto' : 'productos'} · ${money(q.total)}`;
}

function flashCart() {
  const el = $('#cart');
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

async function confirmOrder() {
  if (state.confirming) return;
  state.confirming = true;
  $('#form-error').hidden = true;
  renderCart();
  try {
    const order = await api('/api/orders', { method: 'POST', body: { cart: state.cart } });
    showSuccess(order);
  } catch (err) {
    $('#form-error').textContent = err.message;
    $('#form-error').hidden = false;
    if (err.data?.quote) applyQuote(err.data.quote);
  } finally {
    state.confirming = false;
    renderCart();
  }
}

function showSuccess(order) {
  const where =
    order.mode === 'envio'
      ? `Te lo llevamos a ${esc(order.address)} · ${esc(order.time)}`
      : `Retirás por ${esc(state.menu.local.address)} · ${esc(order.time)}`;
  $('#cart-success').innerHTML = `
    <div class="emoji">🎉</div>
    <h2>¡Pedido enviado, ${esc(order.customerName)}!</h2>
    <div class="order-number">#${order.id}</div>
    <p>${where}</p>
    <p>Si hay algún cambio te escribimos al ${esc(order.phone)}</p>
    <p>Total ${money(order.total)} · ${esc(state.menu.local.payment)}</p>
    <button class="btn" type="button" id="track-order">📦 Seguir mi pedido</button>
    <button class="btn btn-ghost" type="button" id="new-order">Hacer otro pedido</button>`;
  saveTracked({ id: order.id, token: order.trackingToken });
  $('#cart-order').hidden = true;
  $('#cart-success').hidden = false;
  $('#mobile-bar').hidden = true;
  addBubble('bot', `¡Listo! Tu pedido #${order.id} ya está en la cocina 🙌`);
  setComposerEnabled(false);
  $('#cart').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetAll() {
  state.cart = emptyCart();
  state.quote = null;
  state.messages = [];
  $('#messages').innerHTML = '';
  addBubble('bot', GREETING);
  $('#cart-order').hidden = false;
  $('#cart-success').hidden = true;
  $('#form-error').hidden = true;
  syncForm();
  setComposerEnabled(true);
  updateHint();
  renderCart();
  showTab('chat');
}

// ---------- Chat ----------

function scrollChat() {
  const box = $('#messages');
  box.scrollTop = box.scrollHeight;
}

function addBubble(role, text) {
  const div = document.createElement('div');
  div.className = `bubble ${role}`;
  div.textContent = text;
  $('#messages').append(div);
  scrollChat();
  return div;
}

function addErrorBubble(message, action) {
  const div = document.createElement('div');
  div.className = 'bubble error';
  div.setAttribute('role', 'alert');
  div.textContent = `⚠️ ${message}`;
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    div.append(document.createElement('br'), btn);
  }
  $('#messages').append(div);
  scrollChat();
}

function addTyping() {
  const div = document.createElement('div');
  div.className = 'bubble bot typing';
  div.setAttribute('aria-label', 'Escribiendo');
  div.innerHTML = '<span></span><span></span><span></span>';
  $('#messages').append(div);
  scrollChat();
  return div;
}

function setComposerEnabled(enabled) {
  $('#chat-input').disabled = !enabled;
  $('#send-btn').disabled = !enabled;
  $('#example-btn').disabled = !enabled;
}

function updateHint() {
  const turnsLeft = Math.floor((MAX_MESSAGES - state.messages.length) / 2);
  $('#chat-hint').textContent =
    turnsLeft <= 0 ? 'Llegaste al máximo de mensajes' : turnsLeft <= 5 ? `Te quedan ${turnsLeft} mensajes` : 'Enter para enviar';
}

function autoresize() {
  const ta = $('#chat-input');
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
}

function applyAiCart(cart) {
  state.cart = {
    items: cart.items.map(({ id, qty, notes }) => ({ id, qty, notes })),
    customerName: cart.customerName,
    phone: cart.phone,
    email: cart.email,
    mode: cart.mode,
    address: cart.address,
    addressDetails: cart.addressDetails,
    time: cart.time,
  };
  quoteSeq++; // descartamos cotizaciones viejas en vuelo
  applyQuote(cart);
  syncForm();
  flashCart();
}

async function sendMessage() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text || state.sending) return;
  if (state.messages.length + 1 > MAX_MESSAGES) {
    addErrorBubble('Llegamos al máximo de mensajes de esta charla. Completá los datos en el carrito y confirmá.');
    return;
  }

  state.messages.push({ role: 'user', content: text });
  const bubble = addBubble('me', text);
  input.value = '';
  autoresize();
  state.sending = true;
  setComposerEnabled(false);
  const typing = addTyping();

  try {
    const data = await api('/api/chat', { method: 'POST', body: { messages: state.messages, cart: state.cart } });
    state.messages.push({ role: 'assistant', content: data.reply });
    addBubble('bot', data.reply);
    applyAiCart(data.cart);
  } catch (err) {
    // Sacamos el mensaje fallido del historial y lo devolvemos al input para reintentar.
    state.messages.pop();
    bubble.remove();
    input.value = text;
    autoresize();
    const action =
      err.code === 'ai_not_configured' ? { label: '📋 Armar desde el menú', onClick: () => showTab('menu') } : null;
    addErrorBubble(err.message, action);
  } finally {
    typing.remove();
    state.sending = false;
    setComposerEnabled(state.messages.length < MAX_MESSAGES);
    updateHint();
    if (window.matchMedia('(min-width: 900px)').matches) input.focus();
  }
}

function loadExample() {
  const input = $('#chat-input');
  input.value = EXAMPLES[state.exampleIndex % EXAMPLES.length];
  state.exampleIndex++;
  autoresize();
  input.focus();
}

async function checkAi() {
  try {
    const { ai } = await api('/api/health');
    const banner = $('#ai-banner');
    banner.hidden = ai;
    banner.textContent = 'El asistente con IA todavía no está activo. Podés armar tu pedido desde la pestaña "Menú" 📋';
  } catch {
    // Si falla, el error aparece cuando se intente chatear.
  }
}

// ---------- Mis pedidos (sin usuario: id + código secreto guardados en este navegador) ----------

const TRACK_KEY = 'marios-pedidos';
const TRACK_POLL_MS = 10_000;
const STEPS = ['nuevo', 'preparando', 'listo'];

function readTracked() {
  try {
    const list = JSON.parse(localStorage.getItem(TRACK_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((t) => t?.id && t?.token) : [];
  } catch {
    return [];
  }
}

function saveTracked(entry) {
  try {
    const list = readTracked().filter((t) => t.id !== entry.id);
    list.unshift(entry);
    localStorage.setItem(TRACK_KEY, JSON.stringify(list.slice(0, 10)));
  } catch {
    // Sin storage (modo incógnito, etc.): igual se puede buscar con n.º + teléfono.
  }
}

function removeTracked(id) {
  try {
    localStorage.setItem(TRACK_KEY, JSON.stringify(readTracked().filter((t) => t.id !== id)));
  } catch {
    // nada
  }
}

function statusText(order) {
  if (order.status === 'nuevo') return 'Recibimos tu pedido 👍';
  if (order.status === 'preparando') return 'Lo estamos preparando 👨‍🍳';
  return order.mode === 'envio' ? '¡Listo! Sale para tu casa 🛵' : '¡Listo para retirar! 🎉';
}

function trackCard(order) {
  const step = STEPS.indexOf(order.status);
  const labels = ['Recibido', 'Preparando', order.mode === 'envio' ? 'En camino' : 'Para retirar'];
  const when = new Date(order.createdAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  const items = order.items.map((l) => `${l.qty}× ${esc(l.name)}${l.notes ? ` (${esc(l.notes)})` : ''}`).join(' · ');
  return `<article class="track card" data-status="${esc(order.status)}">
    <div class="track-head">
      <span class="order-id">#${order.id}</span>
      <span class="hint">Pedido a las ${when}</span>
    </div>
    <div class="track-status">${statusText(order)}</div>
    <ol class="steps">${labels
      .map((label, i) => `<li class="${i <= step ? 'done' : ''}${i === step ? ' current' : ''}">${label}</li>`)
      .join('')}</ol>
    <p class="track-items">${items}</p>
    <p class="hint">${order.mode === 'envio' ? `Envío a ${esc(order.address)}` : 'Retiro en el local'} · ${esc(order.time)} · <strong>${money(order.total)}</strong></p>
  </article>`;
}

let trackLoading = false;
async function loadMyOrders() {
  const box = $('#my-orders-list');
  const tracked = readTracked();
  if (!tracked.length) {
    box.innerHTML = `<div class="empty"><span class="emoji">📦</span>Todavía no hiciste pedidos desde este celu.<br>Cuando confirmes uno, lo vas a poder seguir acá.</div>`;
    return;
  }
  if (trackLoading) return;
  trackLoading = true;
  if (!box.children.length) box.innerHTML = '<div class="skeleton"></div>';

  const results = await Promise.all(
    tracked.map((t) =>
      api(`/api/track/${t.id}?token=${encodeURIComponent(t.token)}`)
        .then((order) => ({ order }))
        .catch((err) => ({ t, err })),
    ),
  );
  trackLoading = false;

  box.innerHTML = results
    .map(({ order, t, err }) => {
      if (order) return trackCard(order);
      if (err.code === 'not_found') {
        return `<div class="form-error">No encontramos el pedido #${t.id}. Si el local reinició el sistema, se pudo haber borrado; llamalos al ${esc(state.menu?.local.phone ?? '')}.
          <br><button class="btn btn-ghost btn-sm" type="button" data-untrack="${t.id}" style="margin-top:8px">Quitar de la lista</button></div>`;
      }
      return `<div class="form-error">No pudimos actualizar el pedido #${t.id}: ${esc(err.message)}</div>`;
    })
    .join('');
}

async function lookupOrder(e) {
  e.preventDefault();
  const errorBox = $('#lookup-error');
  errorBox.hidden = true;
  $('#lookup-btn').disabled = true;
  $('#lookup-btn').textContent = 'Buscando…';
  try {
    const order = await api('/api/track/lookup', {
      method: 'POST',
      body: { id: Number($('#lookup-id').value), phone: $('#lookup-phone').value },
    });
    saveTracked({ id: order.id, token: order.token });
    $('#lookup-form').reset();
    await loadMyOrders();
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
  } finally {
    $('#lookup-btn').disabled = false;
    $('#lookup-btn').textContent = 'Buscar pedido';
  }
}

// ---------- Init ----------

function init() {
  mountCart();
  renderCart();
  addBubble('bot', GREETING);
  updateHint();

  $('#tab-chat').addEventListener('click', () => showTab('chat'));
  $('#tab-menu').addEventListener('click', () => showTab('menu'));
  $('#tab-orders').addEventListener('click', () => showTab('orders'));
  $('#lookup-form').addEventListener('submit', lookupOrder);
  $('#my-orders-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-untrack]');
    if (!btn) return;
    removeTracked(Number(btn.dataset.untrack));
    loadMyOrders();
  });
  // Mientras la pestaña "Mis pedidos" está abierta, el estado se actualiza solo.
  setInterval(() => {
    if (!$('#view-orders').hidden && document.visibilityState === 'visible') loadMyOrders();
  }, TRACK_POLL_MS);

  $('#view-menu').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-add]');
    if (!btn) return;
    const id = btn.dataset.add;
    const select = $('#view-menu').querySelector(`[data-variant-for="${CSS.escape(id)}"]`);
    addItem(id, select ? select.value : '');
  });

  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage();
  });
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  $('#chat-input').addEventListener('input', autoresize);
  $('#example-btn').addEventListener('click', loadExample);
  $('#mobile-bar-btn').addEventListener('click', () => $('#cart').scrollIntoView({ behavior: 'smooth', block: 'start' }));

  loadMenu();
  checkAi();
}

init();
