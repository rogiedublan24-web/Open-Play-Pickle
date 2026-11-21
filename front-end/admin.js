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
const STATUSES = ['pending', 'confirmed', 'cancelled'];
const TAGS = ['Bagong Manlalaro', 'Regular', 'Bisita'];
const PAYMENT = ['Unpaid', 'Paid'];

const $ = (id) => document.getElementById(id);

// The admin key is typed by the admin every time the page is opened.
// It is kept only in memory (never saved), so refreshing the page asks for it again.
let adminKey = '';
try { sessionStorage.removeItem(KEY_STORAGE); } catch { /* storage blocked */ }

let page = 1;
let currentMode = 'open';    // 'open' = Open Play, 'team' = By Team (the server decides)
let lastOccupied = 0;        // used in the switch warning
let payFilter = '';          // the active payment chip: '' (all) | 'pending' | 'unpaid' | 'paid'

// The event title that is set automatically when you switch the registration type
const DEFAULT_TITLES = {
  open: 'Open Play Event',
  team: 'Pickleball Doubles Tournament',
};

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
  setMax: (value, mode) => request('/settings/max-players', {
    method: 'PATCH',
    body: JSON.stringify(mode === 'team' ? { maxTeams: value } : { maxPlayers: value }),
  }),
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
  showTab('registrations');
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
// Changes the words and the table columns to match the active mode
function applyMode(mode) {
  const m = mode === 'team' ? 'team' : 'open';
  currentMode = m;
  const team = m === 'team';
  if (document.activeElement !== $('mode-select')) $('mode-select').value = m;
  $('lbl-occupied').textContent = team ? 'Teams' : 'Players';
  $('lbl-max').textContent = team ? 'Max teams' : 'Max players';
  $('max-label').textContent = team ? 'Change maximum teams' : 'Change maximum players';
  $('th-player').textContent = team ? 'Team' : 'Player';
  $('filter-search').closest('.field').querySelector('label').textContent = team ? 'Search team' : 'Search player';
  $('tag-field').hidden = team;
  $('reg-table').dataset.mode = m;
}

function renderSlotSummary(s) {
  if (s.mode) applyMode(s.mode);
  lastOccupied = s.occupied;
  $('sum-occupied').textContent = s.occupied;
  $('sum-available').textContent = s.availableSlots;
  $('sum-max').textContent = s.max ?? s.maxPlayers;
  if (document.activeElement !== $('max-input')) $('max-input').value = s.max ?? s.maxPlayers;
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
    const result = await api.setMax(value, currentMode);   // response already contains the new slot summary
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

  const isTeam = reg.kind === 'team';
  const label = isTeam ? (reg.teamName || reg.fullName) : reg.fullName;   // used in messages
  const tagSelect = makeSelect(TAGS, reg.playerTag, `Tag for ${label}`);
  tagSelect.className = 'tag-select';
  tagSelect.dataset.tag = reg.playerTag;
  tagSelect.addEventListener('change', () => { tagSelect.dataset.tag = tagSelect.value; });
  const statusSelect = makeSelect(STATUSES, reg.status, `Status for ${label}`);
  const paidSelect = makeSelect(PAYMENT, reg.paid ? 'Paid' : 'Unpaid', `Payment for ${label}`);
  paidSelect.className = 'paid-select';
  paidSelect.dataset.paid = String(Boolean(reg.paid));
  paidSelect.addEventListener('change', () => {
    paidSelect.dataset.paid = String(paidSelect.value === 'Paid');
    // Marking a pending player as paid also confirms them
    if (paidSelect.value === 'Paid' && statusSelect.value === 'pending') statusSelect.value = 'confirmed';
  });

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
        paid: paidSelect.value === 'Paid',
      });
      showMessage(`${label}: ${result.message}`, 'ok');
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
      title: isTeam ? 'Delete this team?' : 'Delete this registration?',
      message: `${label} will be removed from the list. This cannot be undone.`,
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

  const playerCell = isTeam
    ? cell(textWithSub(reg.teamName || '(no team name)', `P1: ${reg.fullName} · P2: ${reg.partnerName || '-'}`))
    : cell(textWithSub(reg.fullName, reg.email));
  const addressCell = cell(address);
  addressCell.className = 'col-addr';
  const tagCell = cell(tagSelect);
  tagCell.className = 'col-tag';

  tr.append(
    cell(String(number)),
    playerCell,
    cell(textWithSub(reg.contactNumber, reg.paymentRef ? `Ref: ${reg.paymentRef}` : '')),
    addressCell,
    cell(registered),
    tagCell,
    cell(statusSelect),
    cell(paidSelect),
    cell(actions),
  );
  return tr;
}

function renderChipCounts(counts) {
  if (!counts) return;
  ['all', 'pending', 'unpaid', 'paid'].forEach((k) => { $(`chip-${k}`).textContent = counts[k] ?? 0; });
  // Pending = reference numbers waiting for you: the chip stands out when there is something to check
  document.querySelector('.chip-pending').classList.toggle('alert', (counts.pending || 0) > 0);
}

function setPayFilter(value) {
  payFilter = value;
  document.querySelectorAll('#pay-chips .chip').forEach((chip) => {
    const on = chip.dataset.pay === value;
    chip.classList.toggle('active', on);
    chip.setAttribute('aria-pressed', String(on));
  });
}

function renderTable({ total, registrations, paidCount, unpaidCount, mode, counts }) {
  if (mode) applyMode(mode);
  renderChipCounts(counts);
  const body = $('reg-body');
  body.replaceChildren();

  // Paid / unpaid totals for the players who hold a slot
  if (typeof paidCount === 'number') $('sum-paid').textContent = paidCount;
  if (typeof unpaidCount === 'number') $('sum-unpaid').textContent = unpaidCount;

  if (registrations.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 9;
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

// The current filter choices, used by the table and by the CSV export
function currentFilters() {
  const params = {};
  if ($('filter-status').value) params.status = $('filter-status').value;
  if ($('filter-tag').value) params.playerTag = $('filter-tag').value;
  if (payFilter) params.payment = payFilter;
  const search = $('filter-search').value.trim();
  if (search) params.q = search;
  return params;
}

async function loadRegistrations() {
  const data = await api.getRegistrations({ page, limit: PAGE_SIZE, ...currentFilters() });

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

// Search box: waits a moment after typing, so the list is not reloaded on every key
let searchTimer = null;
$('filter-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(reloadFromFirstPage, 350);
});
$('filter-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimer); reloadFromFirstPage(); }
});

$('filter-status').addEventListener('change', reloadFromFirstPage);
$('filter-tag').addEventListener('change', reloadFromFirstPage);
document.querySelectorAll('#pay-chips .chip').forEach((chip) => {
  chip.addEventListener('click', () => { setPayFilter(chip.dataset.pay); reloadFromFirstPage(); });
});
$('refresh-btn').addEventListener('click', () => {
  showMessage('', '');
  Promise.all([loadRegistrations(), loadSlots()]).catch(handleError);
});
$('prev-btn').addEventListener('click', () => { page -= 1; loadRegistrations().catch(handleError); });
$('next-btn').addEventListener('click', () => { page += 1; loadRegistrations().catch(handleError); });

/* =====================================================================
   6b. EXPORT TO CSV - downloads every registration that matches the filters
   ===================================================================== */
// Names and addresses are typed by visitors. A cell that starts with = + - or @
// could run as a formula when the file is opened in Excel, so we put a ' in front.
// Phone numbers are written as ="0917..." so Excel keeps the leading zero.
function csvCell(value, { phone = false } = {}) {
  const text = value === null || value === undefined ? '' : String(value);
  if (phone && /^\+?\d+$/.test(text)) return `"=""${text}"""`;
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

function formatManila(iso) {
  return new Date(iso).toLocaleString(LOCALE, { timeZone: TIMEZONE, dateStyle: 'medium', timeStyle: 'short' });
}

async function exportCsv() {
  const btn = $('export-btn');
  btn.disabled = true;
  showMessage('Preparing the file...', '');

  try {
    const all = [];
    let pageNo = 1;
    let total = 0;
    do {
      const data = await api.getRegistrations({ page: pageNo, limit: 100, ...currentFilters() });
      total = data.total;
      if (data.registrations.length === 0) break;
      all.push(...data.registrations);
      pageNo += 1;
    } while (all.length < total && pageNo <= 50);

    if (all.length === 0) {
      showMessage('There is nothing to export for this filter.', 'bad');
      return;
    }

    const team = currentMode === 'team';
    const header = team ? [
      'No.', 'Team name', 'Player 1 (captain)', 'Contact number', 'Player 2',
      'Status', 'Payment', 'GCash reference', 'On public list', 'Registered (PH time)',
    ] : [
      'No.', 'Full name', 'Contact number', 'Email', 'Province', 'Municipality / City',
      'Barangay', 'Player tag', 'Status', 'Payment', 'GCash reference', 'On public list', 'Registered (PH time)',
    ];
    const rows = all.map((r, i) => team ? [
      csvCell(i + 1),
      csvCell(r.teamName),
      csvCell(r.fullName),
      csvCell(r.contactNumber, { phone: true }),
      csvCell(r.partnerName),
      csvCell(r.status),
      csvCell(r.paid ? 'Paid' : 'Unpaid'),
      csvCell(r.paymentRef, { phone: true }),
      csvCell(r.showOnPublicList ? 'Yes' : 'No'),
      csvCell(formatManila(r.registrationTimestamp)),
    ] : [
      csvCell(i + 1),
      csvCell(r.fullName),
      csvCell(r.contactNumber, { phone: true }),
      csvCell(r.email),
      csvCell(r.province),
      csvCell(r.municipalityOrCity),
      csvCell(r.barangay),
      csvCell(r.playerTag),
      csvCell(r.status),
      csvCell(r.paid ? 'Paid' : 'Unpaid'),
      csvCell(r.paymentRef, { phone: true }),
      csvCell(r.showOnPublicList ? 'Yes' : 'No'),
      csvCell(formatManila(r.registrationTimestamp)),
    ]);

    const csv = '\uFEFF' + [header.map((h) => csvCell(h)), ...rows].map((r) => r.join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date());

    const link = document.createElement('a');
    link.href = url;
    link.download = `${currentMode === 'team' ? 'teams' : 'registrations'}-${today}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    showMessage(`Exported ${all.length} registration${all.length === 1 ? '' : 's'}.`, 'ok');
  } catch (err) {
    handleError(err);
  } finally {
    btn.disabled = false;
  }
}

$('export-btn').addEventListener('click', exportCsv);

/* =====================================================================
   6c. SWITCH REGISTRATION TYPE - Open Play <-> By Team
   ===================================================================== */
function showModeMessage(text, kind) {
  const el = $('mode-msg');
  el.textContent = text;
  el.className = 'form-msg' + (kind ? ` ${kind}` : '');
}

$('mode-btn').addEventListener('click', async () => {
  showModeMessage('', '');
  const target = $('mode-select').value;
  if (target === currentMode) return showModeMessage('That type is already active.', '');

  const toTeam = target === 'team';
  const hiding = lastOccupied;
  const hidden = currentMode === 'team' ? 'teams' : 'Open Play players';
  const sure = await showDialog({
    kind: 'danger',
    title: toTeam ? 'Switch to By Team?' : 'Switch to Open Play?',
    message: `Switching to ${toTeam ? 'By Team' : 'Open Play'} will hide the ${hiding} ${hiding === 1 ? hidden.replace(/s$/, '') : hidden} now on the list. They are not deleted, and they come back when you switch again. The public page will show the ${toTeam ? 'team' : 'player'} form and list right away. The event title will change to "${DEFAULT_TITLES[target]}" (you can edit it in the Event tab).`,
    confirmText: 'Yes, switch',
    cancelText: 'Cancel',
  });
  if (!sure) { $('mode-select').value = currentMode; return; }

  const btn = $('mode-btn');
  btn.disabled = true;
  try {
    const result = await api.updateEvent({ mode: target, title: DEFAULT_TITLES[target] });
    if (result?.event) fillEventForm(result.event);   // the Event tab shows the new title too
    page = 1;
    $('filter-search').value = '';
    $('filter-status').value = '';
    $('filter-tag').value = '';
    setPayFilter('');
    await Promise.all([loadRegistrations(), loadSlots()]);
    showModeMessage(`Now using ${toTeam ? 'By Team' : 'Open Play'} registration.`, 'ok');
  } catch (err) {
    if (err.status === 401) return logout('Your admin key was rejected. Please sign in again.');
    showModeMessage(errorText(err), 'bad');
  } finally {
    btn.disabled = false;
  }
});

/* =====================================================================
   6d. TABS - Registrations | Event | Settings
   ===================================================================== */
function showTab(name) {
  document.querySelectorAll('.admin-tabs .tab').forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
}
document.querySelectorAll('.admin-tabs .tab').forEach((t) => {
  t.addEventListener('click', () => showTab(t.dataset.tab));
});

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

// The QR image is shrunk in the browser first, so it stays small in the database
let qrData = '';

function renderQr() {
  $('qr-preview').hidden = !qrData;
  if (qrData) $('qr-img').src = qrData;
}

function shrinkImage(file, maxSize = 480) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      let data = canvas.toDataURL('image/png');
      if (data.length > 250000) data = canvas.toDataURL('image/jpeg', 0.85);
      resolve(data);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
    img.src = url;
  });
}

$('ev-gcash-qr').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  showEventMessage('', '');
  try {
    qrData = await shrinkImage(file);
    renderQr();
    showEventMessage('QR loaded. Press "Save event details" to publish it.', 'ok');
  } catch {
    showEventMessage('That image could not be read. Please use a PNG or JPG file.', 'bad');
  }
  e.target.value = '';
});

$('qr-remove').addEventListener('click', () => {
  qrData = '';
  renderQr();
  showEventMessage('QR removed. Press "Save event details" to save.', 'ok');
});

function fillEventForm(ev) {
  $('ev-title').value = ev.title || '';
  $('ev-level').value = ev.level || '';
  $('ev-tagline').value = ev.tagline || '';
  $('ev-start').value = toManilaInput(ev.startsAt);
  $('ev-end').value = toManilaInput(ev.endsAt);
  $('ev-venue').value = ev.venue || '';
  $('ev-address').value = ev.address || '';
  $('ev-fee').value = ev.fee || '';
  $('ev-gcash-name').value = ev.gcashName || '';
  $('ev-gcash-number').value = ev.gcashNumber || '';
  qrData = ev.gcashQr || '';
  renderQr();
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
    gcashName: $('ev-gcash-name').value.trim(),
    gcashNumber: $('ev-gcash-number').value.trim(),
    gcashQr: qrData,
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

/* =====================================================================
   AUTO-HIDE - green success messages disappear by themselves after 4 seconds.
   Red error messages stay until the problem is fixed.
   ===================================================================== */
(function autoHideSuccessMessages() {
  const HIDE_AFTER_MS = 8000;
  const timers = new WeakMap();
  document.querySelectorAll('.form-msg').forEach((el) => {
    const check = () => {
      clearTimeout(timers.get(el));
      if (el.classList.contains('ok') && el.textContent.trim()) {
        timers.set(el, setTimeout(() => { el.textContent = ''; el.className = 'form-msg'; }, HIDE_AFTER_MS));
      }
    };
    new MutationObserver(check).observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  });
})();