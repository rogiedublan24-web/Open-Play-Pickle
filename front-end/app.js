'use strict';

/* =====================================================================
   1. CONFIG - the API address lives in config.js
   ===================================================================== */
const { API_BASE, POLL_MS } = window.APP_CONFIG;
const REQUEST_TIMEOUT_MS = 8000;
const LOW_SLOTS_THRESHOLD = 3;   // "Almost full" when 3 or fewer slots are left
const LOCALE = 'en-PH';
const TIMEZONE = 'Asia/Manila';
const NOT_SET = 'To be announced';

/* =====================================================================
   2. API LAYER - every fetch call goes through request()
   ===================================================================== */
class ApiError extends Error {
  constructor(message, status = 0, details = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;     // 0 = network/timeout, 400 = invalid input, 409 = duplicate, ...
    this.details = details;   // list of field problems sent by the server
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
    if (err.name === 'AbortError') throw new ApiError('The server took too long to respond. Please try again.');
    throw new ApiError('Cannot reach the server. Please check that the API is running.');
  } finally {
    clearTimeout(timer);
  }
}

const api = {
  getEvent: () => request('/event'),
  getSlots: () => request('/slots'),
  getPlayers: () => request('/players'),
  register: (payload) => request('/registrations', { method: 'POST', body: JSON.stringify(payload) }),
};

/* =====================================================================
   3. POP-UP BOX - a styled dialog (looks are in styles.css).
      Returns a Promise: true when the main button is pressed, false otherwise.
      Uses textContent (not innerHTML), so names typed by users are safe.
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
   4. RENDERING - uses textContent (not innerHTML) so a malicious name
      cannot inject HTML or scripts (XSS protection)
   ===================================================================== */
const $ = (id) => document.getElementById(id);

// ev = { title, tagline, startsAt, endsAt, venue, address, fee, level, notes } from GET /event
function renderEvent(ev) {
  const fmtDate = new Intl.DateTimeFormat(LOCALE, {
    timeZone: TIMEZONE, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const fmtTime = new Intl.DateTimeFormat(LOCALE, { timeZone: TIMEZONE, hour: 'numeric', minute: '2-digit' });
  const start = ev.startsAt ? new Date(ev.startsAt) : null;
  const end = ev.endsAt ? new Date(ev.endsAt) : null;

  document.title = ev.title;
  $('event-title').textContent = ev.title;
  $('event-tagline').textContent = ev.tagline;
  $('event-tagline').hidden = !ev.tagline;
  $('info-date').textContent = start ? fmtDate.format(start) : NOT_SET;
  $('info-time').textContent = !start ? NOT_SET
    : end ? `${fmtTime.format(start)} - ${fmtTime.format(end)}`
    : fmtTime.format(start);
  $('info-venue').textContent = [ev.venue, ev.address].filter(Boolean).join(', ') || NOT_SET;
  $('info-fee').textContent = ev.fee || NOT_SET;
  $('info-level').textContent = ev.level || NOT_SET;

  const notes = $('info-notes');
  notes.replaceChildren();
  ev.notes.forEach((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    notes.appendChild(li);
  });
}

let isFull = false;
let waitlistFull = false;
let submitting = false;

function updateSubmitButton() {
  const btn = $('submit-btn');
  btn.disabled = submitting || waitlistFull;
  btn.textContent = submitting ? 'Registering...'
    : waitlistFull ? 'Session and waitlist full'
    : isFull ? 'Join the waitlist'
    : 'Reserve my slot';
}

// slots   = { maxPlayers, occupied, availableSlots, waitlisted, isFull }   from GET /slots
// players = [ { displayName, playerTag } ]                                  from GET /players
function renderSlots(slots, players) {
  const max = slots.maxPlayers;
  const registered = Math.min(slots.occupied, max);
  const left = slots.availableSlots;
  isFull = slots.isFull;
  waitlistFull = Boolean(slots.waitlistFull);

  // Counter and progress bar
  $('slot-registered').textContent = registered;
  $('slot-max').textContent = max;
  const meter = $('slot-meter');
  meter.setAttribute('aria-valuemax', max);
  meter.setAttribute('aria-valuenow', registered);
  const fill = $('slot-meter-fill');
  fill.style.width = `${(registered / max) * 100}%`;
  fill.className = 'meter-fill' + (isFull ? ' full' : left <= LOW_SLOTS_THRESHOLD ? ' low' : '');

  // Status badge
  const badge = $('slot-status');
  if (isFull) { badge.dataset.state = 'full'; badge.textContent = 'Full'; }
  else if (left <= LOW_SLOTS_THRESHOLD) { badge.dataset.state = 'low'; badge.textContent = 'Almost full'; }
  else { badge.dataset.state = 'open'; badge.textContent = 'Open'; }

  let text;
  if (!isFull) text = `${left} slot${left === 1 ? '' : 's'} left.`;
  else if (waitlistFull) text = 'No slots left and the waitlist is full.';
  else text = 'No slots left. New registrations go to the waitlist.';
  if (slots.waitlisted > 0 || waitlistFull) {
    text += slots.maxWaitlist
      ? ` Waitlist: ${slots.waitlisted} of ${slots.maxWaitlist}.`
      : ` ${slots.waitlisted} on the waitlist.`;
  }
  $('slot-left').textContent = text;

  // Slot grid: one cell per slot (filled or empty)
  const grid = $('slot-grid');
  grid.replaceChildren();
  for (let i = 0; i < max; i++) {
    const p = players[i];
    const li = document.createElement('li');
    li.className = 'slot ' + (p ? 'filled' : 'empty');

    const no = document.createElement('span');
    no.className = 'slot-no';
    no.textContent = `Slot ${i + 1}`;

    const name = document.createElement('span');
    name.className = 'slot-name';
    name.textContent = p ? p.displayName : 'Available';

    li.append(no, name);
    if (p?.playerTag) {
      const tag = document.createElement('span');
      tag.className = 'slot-skill';
      tag.textContent = p.playerTag;
      li.appendChild(tag);
    }
    grid.appendChild(li);
  }

  updateSubmitButton();
}

/* =====================================================================
   5. LIVE UPDATES - polling that pauses while the tab is hidden
   ===================================================================== */
let pollTimer = null;

async function refresh() {
  try {
    let eventProblem = '';
    const [slots, players, event] = await Promise.all([
      api.getSlots(),
      api.getPlayers(),
      // the slots still work even if the event details fail to load, but we show why
      api.getEvent().catch((err) => { eventProblem = err.message; return null; }),
    ]);
    if (event) renderEvent(event);
    renderSlots(slots, players);
    $('sync-note').textContent =
      `Last updated: ${new Date().toLocaleTimeString(LOCALE, { timeZone: TIMEZONE })}` +
      (eventProblem ? ` Event details could not be loaded: ${eventProblem}` : '');
  } catch (err) {
    $('sync-note').textContent = `${err.message} Retrying...`;
    $('slot-status').dataset.state = 'loading';
    $('slot-status').textContent = 'Offline';
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (document.hidden) return;                       // do not poll while the tab is hidden
  pollTimer = setTimeout(async () => {
    await refresh();                                 // wait for the request to finish: no overlapping calls
    schedulePoll();
  }, POLL_MS);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { refresh().then(schedulePoll); }
});

/* =====================================================================
   6. FORM - client-side validation, then POST /registrations
   ===================================================================== */
const form = $('reg-form');

const PH_MOBILE = /^(\+63|0)9\d{9}$/;               // 09171234567 or +639171234567

function setError(name, message) {
  const input = $(`f-${name}`);
  $(`err-${name}`).textContent = message || '';
  input.closest('.field').classList.toggle('invalid', Boolean(message));
  input.setAttribute('aria-invalid', message ? 'true' : 'false');
}

function validate(v) {
  let ok = true;
  const check = (name, bad, msg) => { setError(name, bad ? msg : ''); if (bad) ok = false; };

  check('fullName', v.fullName.length < 2, 'Please enter your full name (at least 2 characters).');
  check('contactNumber', !PH_MOBILE.test(v.contactNumber), 'Enter a valid PH mobile number, e.g. 0917 123 4567.');
  check('email', v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email), 'Please enter a valid email address.');
  check('province', !v.province, 'Please enter your province.');
  check('municipalityOrCity', !v.municipalityOrCity, 'Please enter your municipality or city.');
  check('barangay', !v.barangay, 'Please enter your barangay.');
  check('consent', !v.consent, 'Your consent is required to appear on the player list.');
  return ok;
}

function showMessage(text, kind) {
  const el = $('form-msg');
  el.textContent = text;
  el.className = 'form-msg' + (kind ? ` ${kind}` : '');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showMessage('', '');

  const values = {
    fullName: form.fullName.value.trim(),
    contactNumber: form.contactNumber.value.replace(/[\s-]/g, ''),
    email: form.email.value.trim(),
    province: form.province.value.trim(),
    municipalityOrCity: form.municipalityOrCity.value.trim(),
    barangay: form.barangay.value.trim(),
    playerTag: form.playerTag.value,
    consent: form.consent.checked,
  };

  if (!validate(values)) {
    form.querySelector('.invalid input, .invalid select')?.focus();
    return;
  }

  // Send only what the API expects; skip the optional email when it is empty
  const { consent, ...payload } = values;
  payload.showOnPublicList = consent;   // the player agreed to appear on the public list
  if (!payload.email) delete payload.email;

  submitting = true;
  updateSubmitButton();

  try {
    const result = await api.register(payload);
    form.reset();

    // Pop-up box after a successful registration
    const firstName = payload.fullName.split(/\s+/)[0];
    if (result.status === 'waitlisted') {
      showDialog({
        kind: 'info',
        title: 'You are on the waitlist',
        message: `Thank you, ${firstName}. The session is full, so you were added to the waitlist. We will contact you if a slot opens.`,
        confirmText: 'Got it',
      });
    } else {
      showDialog({
        kind: 'success',
        title: 'You are already registered!',
        message: `Thank you, ${firstName}. Your slot is reserved. See you on the court!`,
        confirmText: 'Got it',
      });
    }

    await refresh();                                  // update the slots right away
  } catch (err) {
    showMessage(err.details.length ? err.details.join(' ') : err.message, 'bad');
    if (err.status === 409) await refresh();          // may have just filled up: resync the display
  } finally {
    submitting = false;
    updateSubmitButton();
  }
});

/* =====================================================================
   7. START
   ===================================================================== */
refresh().then(schedulePoll);