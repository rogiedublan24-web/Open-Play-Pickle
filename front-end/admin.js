'use strict';

/* =====================================================================
   1. CONFIG AND STATE
   ===================================================================== */
const { API_BASE } = window.APP_CONFIG;
const LOCALE = 'en-PH';
const TIMEZONE = 'Asia/Manila';
const REQUEST_TIMEOUT_MS = 8000;
const PAGE_SIZE = 20;
const KEY_STORAGE = 'pickleball-admin-key';

// Must match the enums in the API (Registration model)
const STATUSES = ['pending', 'confirmed', 'waitlisted', 'cancelled'];
const TAGS = ['Bagong Manlalaro', 'Regular', 'Waitlist', 'Bisita'];

const $ = (id) => document.getElementById(id);

// The admin key is typed by the admin every time the page is opened.
// It is kept only in memory (never saved), so refreshing the page asks for it again.
let adminKey = '';
try { sessionStorage.removeItem(KEY_STORAGE); } catch { /* storage blocked */ }

let page = 1;

/* =====================================================================
   2. API LAYER - same idea as the public page, plus the x-admin-key header
   ===================================================================== */
class ApiError extends Error {
  constructor(message, status = 0, details = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(API_BASE + path, {
      ...options,
      headers: {
        Accept: 'application/json',
        'x-admin-key': adminKey,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: controller.signal,
    });

    let data = null;
    try { data = await res.json(); } catch { /* no JSON body */ }

    if (!res.ok) {
      throw new ApiError(data?.message || `Server error (${res.status}).`, res.status, data?.details || []);
    }
    return data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err.name === 'AbortError') throw new ApiError('The server took too long to respond.');
    throw new ApiError('Cannot reach the server. Please check that the API is running.');
  } finally {
    clearTimeout(timer);
  }
}

const api = {
  getSlots: () => request('/slots'),
  getRegistrations: (params) => request(`/admin/registrants?${new URLSearchParams(params)}`),
  updateRegistration: (id, body) => request(`/admin/registrants/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteRegistration: (id) => request(`/admin/registrants/${id}`, { method: 'DELETE' }),
  setMaxPlayers: (maxPlayers) => request('/settings/max-players', { method: 'PATCH', body: JSON.stringify({ maxPlayers }) }),
  getEvent: () => request('/admin/event'),
  updateEvent: (body) => request('/admin/event', { method: 'PATCH', body: JSON.stringify(body) }),
};

/* =====================================================================
   3. POP-UP BOX - a styled dialog (looks are in styles.css).
      Returns a Promise: true when the main button is pressed, false otherwise.
   ===================================================================== */
function showDialog({ kind = 'info', title, message, confirmText = 'OK', cancelText = '' }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'modal';
    dialog.setAttribute('aria-labelledby', 'dialog-title');

    const form = document.createElement('form');
    form.method = 'dialog';

    const icon = document.createElement('div');
    icon.className = `modal-icon ${kind}`;
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = kind === 'success' ? '✓' : '!';

    const heading = document.createElement('h2');
    heading.id = 'dialog-title';
    heading.className = 'modal-title';
    heading.textContent = title;

    const text = document.createElement('p');
    text.className = 'modal-text';
    text.textContent = message;

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    if (cancelText) {
      const cancel = document.createElement('button');
      cancel.type = 'submit';
      cancel.value = 'cancel';
      cancel.className = 'btn btn-secondary';
      cancel.textContent = cancelText;
      cancel.autofocus = true;                 // safest default for a confirm box
      actions.appendChild(cancel);
    }

    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.value = 'ok';
    ok.className = 'btn ' + (kind === 'danger' ? 'btn-danger-solid' : 'btn-primary');
    ok.textContent = confirmText;
    if (!cancelText) ok.autofocus = true;
    actions.appendChild(ok);

    form.append(icon, heading, text, actions);
    dialog.appendChild(form);

    dialog.addEventListener('close', () => {
      const confirmed = dialog.returnValue === 'ok';
      dialog.remove();
      resolve(confirmed);
    });
    // Click on the dark background closes the box (counts as Cancel)
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close('cancel'); });

    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

/* =====================================================================
   4. HELPERS
   ===================================================================== */
function showMessage(text, kind) {
  const el = $('admin-msg');
  el.textContent = text;
  el.className = 'form-msg' + (kind ? ` ${kind}` : '');
}

function errorText(err) {
  return err.details?.length ? err.details.join(' ') : err.message;
}

function showPanel(open) {
  $('login-card').hidden = open;
  $('admin-panel').hidden = !open;
}

function logout(message) {
  adminKey = '';
  $('admin-key').value = '';
  showPanel(false);
  const el = $('login-msg');
  el.textContent = message || '';
  el.className = 'form-msg' + (message ? ' bad' : '');
}

// Any 401 means the key is wrong or missing: go back to the sign-in form
function handleError(err) {
  if (err.status === 401) return logout('Your admin key was rejected. Please sign in again.');
  showMessage(errorText(err), 'bad');
}

/* =====================================================================
   5. SLOT SUMMARY AND MAX PLAYERS
   ===================================================================== */
function renderSlotSummary(s) {
  $('sum-occupied').textContent = s.occupied;
  $('sum-available').textContent = s.availableSlots;
  $('sum-waitlisted').textContent = s.maxWaitlist ? `${s.waitlisted} / ${s.maxWaitlist}` : s.waitlisted;
  $('sum-max').textContent = s.maxPlayers;
  if (document.activeElement !== $('max-input')) $('max-input').value = s.maxPlayers;
}

async function loadSlots() {
  renderSlotSummary(await api.getSlots());
}

$('max-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showMessage('', '');

  const value = Number($('max-input').value);
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    return showMessage('Enter a whole number from 1 to 200.', 'bad');
  }

  const btn = $('max-btn');
  btn.disabled = true;
  try {
    const result = await api.setMaxPlayers(value);   // response already contains the new slot summary
    renderSlotSummary(result);
    showMessage(result.message, 'ok');
  } catch (err) {
    handleError(err);
  } finally {
    btn.disabled = false;
  }
});

/* =====================================================================
   6. REGISTRATIONS TABLE
   ===================================================================== */
function makeSelect(options, current, label) {
  const select = document.createElement('select');
  select.setAttribute('aria-label', label);
  options.forEach((value) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    opt.selected = value === current;
    select.appendChild(opt);
  });
  return select;
}

function cell(...children) {
  const td = document.createElement('td');
  td.append(...children);
  return td;
}

function textWithSub(main, sub) {
  const wrap = document.createDocumentFragment();
  wrap.append(main);
  if (sub) {
    const s = document.createElement('span');
    s.className = 'sub';
    s.textContent = sub;
    wrap.appendChild(s);
  }
  return wrap;
}

function buildRow(reg, number) {
  const tr = document.createElement('tr');

  const address = [reg.barangay, reg.municipalityOrCity, reg.province].filter(Boolean).join(', ');
  const registered = new Date(reg.registrationTimestamp).toLocaleString(LOCALE, {
    timeZone: TIMEZONE, dateStyle: 'medium', timeStyle: 'short',
  });

  const tagSelect = makeSelect(TAGS, reg.playerTag, `Tag for ${reg.fullName}`);
  const statusSelect = makeSelect(STATUSES, reg.status, `Status for ${reg.fullName}`);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn-primary btn-sm';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', async () => {
    showMessage('', '');
    saveBtn.disabled = true;
    try {
      const result = await api.updateRegistration(reg._id, {
        status: statusSelect.value,
        playerTag: tagSelect.value,
      });
      showMessage(`${result.registration.fullName}: ${result.message}`, 'ok');
      await Promise.all([loadRegistrations(), loadSlots()]);
    } catch (err) {
      handleError(err);
      saveBtn.disabled = false;
    }
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn btn-danger btn-sm';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', async () => {
    // Pop-up box: "Are you sure?" (Cancel is selected by default)
    const sure = await showDialog({
      kind: 'danger',
      title: 'Delete this registration?',
      message: `${reg.fullName} will be removed from the list. This cannot be undone.`,
      confirmText: 'Yes, delete',
      cancelText: 'Cancel',
    });
    if (!sure) return;

    showMessage('', '');
    deleteBtn.disabled = true;
    saveBtn.disabled = true;
    try {
      const result = await api.deleteRegistration(reg._id);
      showMessage(result.message, 'ok');
      await Promise.all([loadRegistrations(), loadSlots()]);
    } catch (err) {
      handleError(err);
      deleteBtn.disabled = false;
      saveBtn.disabled = false;
    }
  });

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(saveBtn, deleteBtn);

  tr.append(
    cell(String(number)),
    cell(textWithSub(reg.fullName, reg.email)),
    cell(reg.contactNumber),
    cell(address),
    cell(registered),
    cell(tagSelect),
    cell(statusSelect),
    cell(actions),
  );
  return tr;
}

function renderTable({ total, registrations }) {
  const body = $('reg-body');
  body.replaceChildren();

  if (registrations.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8;
    td.className = 'empty-row';
    td.textContent = 'No registrations found.';
    tr.appendChild(td);
    body.appendChild(tr);
  } else {
    registrations.forEach((reg, i) => body.appendChild(buildRow(reg, (page - 1) * PAGE_SIZE + i + 1)));
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  $('page-info').textContent = `Page ${page} of ${pages} · ${total} total`;
  $('prev-btn').disabled = page <= 1;
  $('next-btn').disabled = page >= pages;
}

async function loadRegistrations() {
  const params = { page, limit: PAGE_SIZE };
  if ($('filter-status').value) params.status = $('filter-status').value;
  if ($('filter-tag').value) params.playerTag = $('filter-tag').value;
  const data = await api.getRegistrations(params);

  // The last row of this page was deleted: go back one page
  if (data.registrations.length === 0 && page > 1) {
    page -= 1;
    return loadRegistrations();
  }
  renderTable(data);
}

function reloadFromFirstPage() {
  page = 1;
  showMessage('', '');
  loadRegistrations().catch(handleError);
}

$('filter-status').addEventListener('change', reloadFromFirstPage);
$('filter-tag').addEventListener('change', reloadFromFirstPage);
$('refresh-btn').addEventListener('click', () => {
  showMessage('', '');
  Promise.all([loadRegistrations(), loadSlots()]).catch(handleError);
});
$('prev-btn').addEventListener('click', () => { page -= 1; loadRegistrations().catch(handleError); });
$('next-btn').addEventListener('click', () => { page += 1; loadRegistrations().catch(handleError); });

/* =====================================================================
   7. SIGN IN / SIGN OUT
   ===================================================================== */
async function openPanel() {
  // The first admin-only request doubles as the key check: a wrong key returns 401
  await loadRegistrations();
  await loadSlots();
  showPanel(true);
  loadEvent().catch((err) => showEventMessage(errorText(err), 'bad'));
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = $('admin-key').value.trim();
  const msg = $('login-msg');
  msg.textContent = '';
  msg.className = 'form-msg';
  if (!key) { msg.textContent = 'Enter the admin key.'; msg.className = 'form-msg bad'; return; }

  adminKey = key;
  $('login-btn').disabled = true;
  try {
    await openPanel();
    $('admin-key').value = '';
  } catch (err) {
    adminKey = '';
    msg.textContent = err.status === 401 ? 'Wrong admin key.' : err.message;
    msg.className = 'form-msg bad';
  } finally {
    $('login-btn').disabled = false;
  }
});

$('logout-btn').addEventListener('click', () => logout(''));

/* =====================================================================
   8. EVENT DETAILS - venue, fee, date and time shown on the public page
   ===================================================================== */
function showEventMessage(text, kind) {
  const el = $('event-msg');
  el.textContent = text;
  el.className = 'form-msg' + (kind ? ` ${kind}` : '');
}

// The date/time inputs hold Philippine time (UTC+8, no daylight saving).
// The API stores a real moment in time (ISO string), so we convert both ways.
function toManilaInput(iso) {
  if (!iso) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

function fromManilaInput(value) {
  return value ? new Date(`${value}:00+08:00`).toISOString() : null;
}

function fillEventForm(ev) {
  $('ev-title').value = ev.title || '';
  $('ev-level').value = ev.level || '';
  $('ev-tagline').value = ev.tagline || '';
  $('ev-start').value = toManilaInput(ev.startsAt);
  $('ev-end').value = toManilaInput(ev.endsAt);
  $('ev-venue').value = ev.venue || '';
  $('ev-address').value = ev.address || '';
  $('ev-fee').value = ev.fee || '';
  $('ev-notes').value = (ev.notes || []).join('\n');
}

async function loadEvent() {
  fillEventForm(await api.getEvent());
}

$('event-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showEventMessage('', '');

  const body = {
    title: $('ev-title').value.trim(),
    level: $('ev-level').value.trim(),
    tagline: $('ev-tagline').value.trim(),
    startsAt: fromManilaInput($('ev-start').value),
    endsAt: fromManilaInput($('ev-end').value),
    venue: $('ev-venue').value.trim(),
    address: $('ev-address').value.trim(),
    fee: $('ev-fee').value.trim(),
    notes: $('ev-notes').value.split('\n').map((line) => line.trim()).filter(Boolean),
  };

  if (!body.title) return showEventMessage('The title cannot be empty.', 'bad');
  if (body.startsAt && body.endsAt && new Date(body.endsAt) <= new Date(body.startsAt)) {
    return showEventMessage('The end time must be later than the start time.', 'bad');
  }

  const btn = $('event-btn');
  btn.disabled = true;
  try {
    const result = await api.updateEvent(body);
    fillEventForm(result.event);
    showEventMessage(result.message, 'ok');
  } catch (err) {
    if (err.status === 401) return logout('Your admin key was rejected. Please sign in again.');
    showEventMessage(errorText(err), 'bad');
  } finally {
    btn.disabled = false;
  }
});