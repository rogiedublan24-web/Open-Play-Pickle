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
  sendReference: (payload) => request('/payment-ref', { method: 'POST', body: JSON.stringify(payload) }),
};

/* =====================================================================
   3. POP-UP BOX - a styled dialog (looks are in styles.css).
      Returns a Promise: true when the main button is pressed, false otherwise.
      Uses textContent (not innerHTML), so names typed by users are safe.
   ===================================================================== */
function showDialog({ kind = 'info', title, message, confirmText = 'OK', cancelText = '', listenText = '' }) {
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

    form.append(icon, heading, text);
    if (listenText) {
      // Always shown. A real tap on this button allows the voice, even on phones.
      const listen = document.createElement('button');
      listen.type = 'button';
      listen.className = 'btn btn-secondary btn-sm modal-listen';
      listen.textContent = '🔊 Listen';
      listen.addEventListener('click', () => playVoice(listenText, true));
      form.appendChild(listen);
    }
    form.appendChild(actions);
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
   3b. VOICE - the browser reads a message out loud (free, built in, no AI service)
   ===================================================================== */
// A recorded voice file (works in every browser, including Messenger/Facebook).
// Put your file in the same folder as index.html and name it: registered.mp3
const voiceFiles = {
  confirmed: new Audio('registered.mp3'),       // "Thank you! Your slot is reserved. See you on the court!"
  pending: new Audio('registered-pay.mp3'),     // the one that mentions paying online or at the event
};
Object.values(voiceFiles).forEach((audio) => { audio.preload = 'auto'; });
let doneAudio = voiceFiles.confirmed;           // the file for the current registration

function playVoice(text, immediate = false) {
  // Normal browsers (Chrome, Safari...): the natural voice of the phone, which can say the player's name.
  if ('speechSynthesis' in window) { speak(text, immediate); return; }
  // Browsers with no voice (Messenger / Facebook): play the recorded file instead.
  try {
    doneAudio.muted = false;
    doneAudio.currentTime = 0;
    const played = doneAudio.play();
    if (played && played.catch) played.catch(() => { /* blocked: the message is still shown in the pop-up */ });
  } catch { /* ignore */ }
}

// Phones only allow speech that starts from a tap. Call this at the very start of the
// button handler (before any waiting) so the later speak() is allowed.
function unlockSpeech() {
  Object.values(voiceFiles).forEach((audio) => {   // unlock the recorded voices too
    try {
      audio.muted = true;
      audio.play().then(() => { audio.pause(); audio.currentTime = 0; audio.muted = false; })
        .catch(() => { audio.muted = false; });
    } catch { /* ignore */ }
  });
  if (!('speechSynthesis' in window)) return;
  try {
    const quiet = new SpeechSynthesisUtterance(' ');
    quiet.volume = 0;
    window.speechSynthesis.speak(quiet);
  } catch { /* ignore */ }
}

let currentVoice = null;   // keep a reference: some phone browsers drop it and the voice goes silent

function pickVoice() {
  const voices = window.speechSynthesis.getVoices();
  return voices.find((v) => /^en[-_]/i.test(v.lang) && /google|samantha|siri/i.test(v.name))
    || voices.find((v) => /^en[-_]/i.test(v.lang))
    || null;
}
if ('speechSynthesis' in window) {
  window.speechSynthesis.addEventListener?.('voiceschanged', pickVoice);   // phones load voices late
}

function speak(text, immediate = false) {
  if (!('speechSynthesis' in window)) return;     // older browsers: just stay silent
  try {
    const synth = window.speechSynthesis;
    synth.cancel();
    const voice = new SpeechSynthesisUtterance(text);
    const chosen = pickVoice();
    if (chosen) voice.voice = chosen;
    voice.lang = chosen ? chosen.lang : 'en-US';
    voice.rate = 1;
    voice.pitch = 1.05;
    voice.volume = 1;
    currentVoice = voice;                         // do not let it be garbage-collected

    let started = false;
    voice.onstart = () => { started = true; };
    const go = () => { synth.resume(); synth.speak(voice); };
    if (immediate) go(); else setTimeout(go, 80);

    // if nothing started after a moment, try once more
    setTimeout(() => {
      if (!started && currentVoice === voice && !synth.speaking) {
        synth.cancel();
        synth.speak(voice);
      }
    }, 1200);
  } catch { /* the voice is a bonus, never break the page */ }
}

function stopSpeaking() {
  Object.values(voiceFiles).forEach((audio) => { try { audio.pause(); audio.currentTime = 0; } catch { /* ignore */ } });
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
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
  (ev.notes || []).forEach((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    notes.appendChild(li);
  });

  // "Get directions" opens Google Maps with the venue and address
  const place = [ev.venue, ev.address].filter(Boolean).join(', ');
  const directions = $('directions-link');
  directions.hidden = !place;
  if (place) {
    directions.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(place);
  }

  // "How to pay" card: visible when the admin entered a GCash number and/or uploaded a QR
  const hasPayment = Boolean(ev.gcashNumber || ev.gcashQr);
  paymentRequired = hasPayment;
  $('pay-card').hidden = !hasPayment;
  $('nav-pay').hidden = !hasPayment;            // the Pay button of the bottom menu
  $('pay-legend').hidden = !hasPayment;         // the Unpaid / Pending / Paid explanation under the slots
  if (hasPayment) {
    $('pay-name').textContent = ev.gcashName || '—';
    $('pay-number').textContent = ev.gcashNumber || '—';
    $('pay-name-wrap').hidden = !ev.gcashName;
    $('pay-number-wrap').hidden = !ev.gcashNumber;
    $('pay-copy').hidden = !ev.gcashNumber;
    $('pay-qr').hidden = !ev.gcashQr;
    if (ev.gcashQr) $('pay-qr').src = ev.gcashQr;
    $('pay-fee').textContent = ev.fee ? `Fee: ${ev.fee}` : '';
    $('pay-fee').hidden = !ev.fee;
  }

  // Text used by the Share button
  shareInfo = {
    title: ev.title,
    text: [ev.title, start ? fmtDate.format(start) : '', place].filter(Boolean).join(' | '),
  };

  updateCountdownTimes(start, end);
  document.documentElement.classList.add('event-ready');   // the real title is in place: show it
}

/* =====================================================================
   4b. COUNTDOWN - counts down to the start time, shows "Happening now"
       while the event runs, and hides itself a while after it ends
   ===================================================================== */
const NO_END_VISIBLE_MS = 12 * 60 * 60 * 1000;   // with no end time, hide 12 hours after the start
let countdownStart = null;
let countdownEnd = null;
let countdownTimer = null;
let shareInfo = { title: document.title, text: document.title };
let paymentRequired = false;   // true when GCash is set up: a reference number is needed

function buildCountdownBoxes() {
  const units = $('countdown-units');
  if (units.children.length) return;
  ['days', 'hours', 'minutes', 'seconds'].forEach((name) => {
    const box = document.createElement('div');
    box.className = 'cd-box';
    const num = document.createElement('b');
    num.dataset.unit = name;
    num.textContent = '00';
    const label = document.createElement('span');
    label.textContent = name;
    box.append(num, label);
    units.appendChild(box);
  });
}

function updateCountdownTimes(start, end) {
  countdownStart = start ? start.getTime() : null;
  countdownEnd = end ? end.getTime() : null;
  buildCountdownBoxes();
  tickCountdown();
  if (!countdownTimer) countdownTimer = setInterval(tickCountdown, 1000);
}

function tickCountdown() {
  const box = $('countdown');
  const now = Date.now();

  // Registration closes when the countdown reaches zero (the event has started)
  const closed = countdownStart !== null && now >= countdownStart;
  if (closed !== registrationClosed) { registrationClosed = closed; updateSubmitButton(); }

  if (countdownStart === null) { box.hidden = true; return; }

  const label = $('countdown-label');
  const units = $('countdown-units');

  if (now < countdownStart) {
    const left = Math.floor((countdownStart - now) / 1000);
    const parts = {
      days: Math.floor(left / 86400),
      hours: Math.floor((left % 86400) / 3600),
      minutes: Math.floor((left % 3600) / 60),
      seconds: left % 60,
    };
    box.hidden = false;
    box.classList.remove('live');
    units.hidden = false;
    label.textContent = 'Registration closes in';
    Object.entries(parts).forEach(([name, value]) => {
      const el = units.querySelector(`[data-unit="${name}"]`);
      if (el) el.textContent = String(value).padStart(2, '0');
    });
    return;
  }

   // The countdown reached zero: registration is closed
  box.hidden = false;
  box.classList.add('live');
  units.hidden = true;
  label.textContent = 'Registration closed';
}

/* =====================================================================
   4c. SHARE AND COPY BUTTONS
   ===================================================================== */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers: copy through a temporary text box
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

function flashButton(button, text) {
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = text;
  clearTimeout(button._flashTimer);
  button._flashTimer = setTimeout(() => { button.textContent = original; }, 2000);
}

$('share-btn').addEventListener('click', async () => {
  const url = location.origin + '/';
  if (navigator.share) {
    try {
      await navigator.share({ title: shareInfo.title, text: shareInfo.text, url });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;      // the person closed the share sheet
    }
  }
  flashButton($('share-btn'), (await copyText(url)) ? 'Link copied!' : 'Copy failed');
});

$('pay-copy').addEventListener('click', async () => {
  const number = $('pay-number').textContent.replace(/[\s-]/g, '');
  flashButton($('pay-copy'), (await copyText(number)) ? 'Copied!' : 'Copy failed');
});

let isFull = false;
let currentMode = 'open';   // 'open' = Open Play form, 'team' = By Team form, 'solo' = Solo form (the organizer chooses in Admin)
let submitting = false;
let registrationClosed = false;   // true once the countdown has reached zero

let viewCategory = '';   // the category whose slots are shown (By Team / Solo): each category has its own slots
let lastSlots = null;    // the last data from the server, so a click on a category can redraw at once
let lastPlayers = [];
let teamCategories = [];   // By Team / Solo categories from GET /slots: [{ id, label, enabled, max, occupied, availableSlots, isFull }]

function selectedCategory() {
  const id = $('tf-category').value;
  return teamCategories.find((c) => c.id === id) || null;
}

function updateSubmitButton() {
  const team = currentMode === 'team';
  const withCategories = currentMode !== 'open';
  const btn = $(withCategories ? 'team-submit-btn' : 'submit-btn');
  const cat = withCategories ? selectedCategory() : null;
  const noCategory = withCategories && !teamCategories.some((c) => c.enabled);
  const catFull = Boolean(cat && cat.isFull);
  btn.disabled = submitting || isFull || registrationClosed || noCategory || catFull;
  btn.textContent = submitting ? 'Registering...'
    : registrationClosed ? 'Registration closed'
    : noCategory ? 'No category is open yet'
    : catFull ? `${cat.label} is full`
    : isFull ? (team ? 'All team slots taken' : 'All slots taken')
    : team ? 'Reserve our team slot'
    : withCategories ? 'Reserve my solo slot'
    : 'Reserve my slot';
}

// Solo categories have one player only: hide the team name and Player 2, and change the words
function applySoloLayout() {
  const solo = currentMode === 'solo';   // Solo: one player, so no team name and no Player 2
  $('field-teamName').hidden = solo;
  $('field-partnerName').hidden = solo;
  // The labels follow the chosen category: Boy / Girl = Player 1 is the boy, Player 2 is the girl
  const cat = $('tf-category').value;
  const who = cat === 'mixed' ? ' (Boy)' : cat === 'allboys' ? ' (Boy)' : cat === 'allgirls' ? ' (Girl)' : '';
  const who2 = cat === 'mixed' ? ' (Girl)' : who;
  $('lbl-fullName').textContent = solo ? 'Your full name' : `Player 1${who} full name`;
  $('lbl-contactNumber').textContent = solo ? 'Your contact number' : `Player 1${who} contact number`;
  const l2 = $('lbl-partnerName');
  if (l2) l2.textContent = `Player 2${who2} full name`;
  $('team-legend').textContent = solo ? 'Where are you from?' : 'Where is your team from?';
  $('team-hint-top').textContent = solo ? 'Solo: you register alone. The organizer will find you a partner.'
    : cat === 'mixed' ? 'One team = 1 boy and 1 girl. Player 1 is the boy (captain), Player 2 is the girl.'
    : 'One team = 2 players. The captain (Player 1) registers the team.';
  $('team-hint-pay').textContent = solo ? 'When you send your GCash reference later, use the contact number you registered with.' : 'One payment per team. When you send your GCash reference later, use the captain\'s contact number.';
  $('consent-text').textContent = solo ? 'I agree to show my first name and last initial on the public list.' : 'I agree to show our team name on the public list.';
  updateSubmitButton();
}

// Fills the category dropdown (only the open ones) and the category buttons under the counter
function renderCategories(cats) {
  teamCategories = cats || [];
  const select = $('tf-category');
  const keep = select.value;
  const open = teamCategories.filter((c) => c.enabled);
  select.replaceChildren();   // no "Choose a category" line: only the open categories are listed
  open.forEach((c) => {
    const o = new Option(c.isFull ? `${c.label} (full)` : `${c.label} (${c.availableSlots} left)`, c.id);
    o.disabled = c.isFull;
    select.appendChild(o);
  });
  const stay = open.find((c) => c.id === keep && !c.isFull);
  const first = open.find((c) => !c.isFull);
  select.value = stay ? stay.id : first ? first.id : '';   // keeps your choice, otherwise the first open category

  const list = $('cat-summary');
  list.replaceChildren();
  if (!open.some((c) => c.id === viewCategory)) viewCategory = open.length ? open[0].id : '';
  open.forEach((c) => {
    const li = document.createElement('li');
    li.className = (c.isFull ? 'full' : '') + (c.id === viewCategory ? ' on' : '');
    li.setAttribute('role', 'button');
    li.tabIndex = 0;
    li.setAttribute('aria-pressed', String(c.id === viewCategory));
    const pick = () => {
      viewCategory = c.id;
      if (!c.isFull) { $('tf-category').value = c.id; applySoloLayout(); }   // the form follows the category you opened
      if (lastSlots) renderSlots(lastSlots, lastPlayers);
    };
    li.addEventListener('click', pick);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    const name = document.createElement('span');
    name.textContent = c.label;
    const count = document.createElement('b');
    count.textContent = `${c.occupied}/${c.max}`;
    li.append(name, count);
    list.appendChild(li);
  });
  list.hidden = currentMode === 'open' || open.length === 0;
  applySoloLayout();
}

$('tf-category').addEventListener('change', () => {
  setTeamError('category', '');
  applySoloLayout();
  if ($('tf-category').value) { viewCategory = $('tf-category').value; if (lastSlots) renderSlots(lastSlots, lastPlayers); }
});

// Shows the Open Play form or the By Team form, and changes the words to match
function applyMode(mode) {
  const m = mode === 'team' || mode === 'solo' ? mode : 'open';
  currentMode = m;
  const team = m === 'team';
  const withCategories = m !== 'open';   // By Team and Solo use the category form
  $('reg-form').hidden = withCategories;
  $('team-form').hidden = !withCategories;
  $('reg-heading').textContent = team ? 'Register your team' : m === 'solo' ? 'Register (Solo)' : 'Register';
  $('counter-label').textContent = team ? 'teams' : 'players';
  $('slot-grid').setAttribute('aria-label', team ? 'Team slots' : 'Player slots');
  if (!withCategories) $('cat-summary').hidden = true;
}

// slots   = { maxPlayers, occupied, availableSlots, waitlisted, isFull }   from GET /slots
// players = [ { displayName, playerTag } ]                                  from GET /players
function renderSlots(slots, players) {
  lastSlots = slots;
  lastPlayers = players;
  applyMode(slots.mode);
  const team = currentMode === 'team';
  if (currentMode !== 'open') renderCategories(slots.categories);
  isFull = slots.isFull;   // everything is full (used by the Reserve button)

  // By Team / Solo: the page shows ONE category at a time, with its own slots and its own max
  const viewCat = currentMode !== 'open' ? teamCategories.find((c) => c.id === viewCategory) : null;
  const max = viewCat ? viewCat.max : (slots.max ?? slots.maxPlayers);
  const registered = Math.min(viewCat ? viewCat.occupied : slots.occupied, max);
  const left = viewCat ? viewCat.availableSlots : slots.availableSlots;
  const shownFull = viewCat ? viewCat.isFull : slots.isFull;
  if (viewCat) players = players.filter((p) => p.category === viewCat.id);

  // Counter and progress bar
  $('slot-registered').textContent = registered;
  $('slot-max').textContent = max;
  const meter = $('slot-meter');
  meter.setAttribute('aria-valuemax', max);
  meter.setAttribute('aria-valuenow', registered);
  const fill = $('slot-meter-fill');
  fill.style.width = `${max ? (registered / max) * 100 : 0}%`;
  fill.className = 'meter-fill' + (shownFull ? ' full' : left <= LOW_SLOTS_THRESHOLD ? ' low' : '');

  // Status badge
  const badge = $('slot-status');
  if (shownFull) { badge.dataset.state = 'full'; badge.textContent = 'Full'; }
  else if (left <= LOW_SLOTS_THRESHOLD) { badge.dataset.state = 'low'; badge.textContent = 'Almost full'; }
  else { badge.dataset.state = 'open'; badge.textContent = 'Open'; }

  const where = viewCat ? ` in ${viewCat.label}` : '';
  $('slot-left').textContent = shownFull
    ? `All slots${where} are taken.`
    : `${left} ${team ? 'team ' : ''}slot${left === 1 ? '' : 's'} left${where}.`;

  // Slot grid: one cell per slot (filled or empty)
  // Slot grid: one cell per slot (filled or empty)
  const grid = $('slot-grid');
  grid.replaceChildren();
  for (let i = 0; i < max; i++) {
    const p = players[i];
    const li = document.createElement('li');
    const payState = p ? (p.payment || (p.paid ? 'paid' : 'unpaid')) : '';   // paid / pending / unpaid
    li.className = 'slot ' + (p ? 'filled' : 'empty') + (p && paymentRequired && payState !== 'paid' ? ` ${payState}` : '');

    const no = document.createElement('span');
    no.className = 'slot-no';
    no.textContent = `${team ? 'Team' : 'Slot'} ${i + 1}`;

    const name = document.createElement('span');
    name.className = 'slot-name';
    name.textContent = p ? p.displayName : 'Available';

    li.append(no, name);
    if (p?.categoryLabel && currentMode !== 'open' && !viewCat) {
      const cat = document.createElement('span');
      cat.className = 'slot-cat';
      cat.textContent = p.categoryLabel;
      li.appendChild(cat);
    }
    if (p?.playerTag && !team) {
      const tag = document.createElement('span');
      tag.className = 'slot-skill';
      tag.dataset.tag = p.playerTag;
      tag.textContent = p.playerTag;
      li.appendChild(tag);
    }
    // Paid / Unpaid chip (only when GCash payment is set up)
    if (p && paymentRequired) {
      const pay = document.createElement('span');
      pay.className = 'slot-pay ' + payState;
      pay.textContent = payState === 'paid' ? 'Paid' : payState === 'pending' ? 'Pending' : 'Unpaid';
      li.appendChild(pay);
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
    if (event) {
      renderEvent(event);
      saveEventCache(event);
    }
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

// The Player type dropdown takes the colour of the chosen type (see styles.css)
const tagSelect = $('f-playerTag');
const syncTagColor = () => { tagSelect.dataset.tag = tagSelect.value; };
tagSelect.addEventListener('change', syncTagColor);
form.addEventListener('reset', () => setTimeout(syncTagColor));
syncTagColor();

// Province and city start filled in (Southern Leyte / Maasin City).
// Tapping a box selects the text, so typing something else replaces it right away.
['f-province', 'f-municipalityOrCity', 'tf-municipalityOrCity'].forEach((id) => {
  $(id).addEventListener('focus', (e) => setTimeout(() => e.target.select(), 0));
});

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
  if (registrationClosed) { showMessage('Registration is closed. The event has already started.', 'bad'); return; }
  unlockSpeech();                       // allow the voice on phones (must happen right on the tap)

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
    const doneMessage = result.status === 'pending'
      ? `Thank you, ${firstName}. Your slot is reserved. You can pay online using the "How to pay" box and send your GCash reference number, or just pay when you arrive at the event.`
      : `Thank you, ${firstName}. Your slot is reserved. See you on the court!`;
    doneAudio = voiceFiles[result.status === 'pending' ? 'pending' : 'confirmed'];   // pick the matching recording
    showDialog({
      kind: 'success',
      title: 'You are already registered!',
      message: doneMessage,
      listenText: doneMessage,
      confirmText: 'Got it',
    }).then(stopSpeaking);
    playVoice(doneMessage);                           // play the recorded voice (or the browser voice)

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
   6a. BY TEAM / SOLO FORM - By Team: one team = 2 players, one payment per team. Solo: one player.
   ===================================================================== */
const teamForm = $('team-form');

function setTeamError(name, message) {
  const input = $(`tf-${name}`);
  $(`terr-${name}`).textContent = message || '';
  input.closest('.field').classList.toggle('invalid', Boolean(message));
  input.setAttribute('aria-invalid', message ? 'true' : 'false');
}

function validateTeam(v) {
  let ok = true;
  const check = (name, bad, msg) => { setTeamError(name, bad ? msg : ''); if (bad) ok = false; };
  const solo = currentMode === 'solo';
  check('category', !v.category, 'Please choose a category.');
  check('teamName', !solo && v.teamName.length < 2, 'Please enter your team name (at least 2 characters).');
  check('fullName', v.fullName.length < 2, solo ? 'Please enter your full name.' : 'Please enter the captain\'s full name.');
  check('contactNumber', !PH_MOBILE.test(v.contactNumber), 'Enter a valid PH mobile number, e.g. 0917 123 4567.');
  check('partnerName', !solo && v.partnerName.length < 2, 'Please enter Player 2\'s name.');
  check('municipalityOrCity', !v.municipalityOrCity, 'Please enter your municipality or city.');
  check('barangay', !v.barangay, 'Please enter your barangay.');
  check('consent', !v.consent, solo ? 'Your consent is required to show your name on the list.' : 'Your consent is required to show the team name on the list.');
  return ok;
}

function showTeamMessage(text, kind) {
  const el = $('team-form-msg');
  el.textContent = text;
  el.className = 'form-msg' + (kind ? ` ${kind}` : '');
}

teamForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  showTeamMessage('', '');
  if (registrationClosed) { showTeamMessage('Registration is closed. The event has already started.', 'bad'); return; }
  unlockSpeech();                       // allow the voice on phones (must happen right on the tap)

  const solo = currentMode === 'solo';
  const values = {
    category: $('tf-category').value,
    teamName: solo ? '' : teamForm.teamName.value.trim(),
    fullName: teamForm.fullName.value.trim(),
    contactNumber: teamForm.contactNumber.value.replace(/[\s-]/g, ''),
    partnerName: solo ? '' : teamForm.partnerName.value.trim(),
    municipalityOrCity: teamForm.municipalityOrCity.value.trim(),
    barangay: teamForm.barangay.value.trim(),
    consent: teamForm.consent.checked,
  };
  if (!validateTeam(values)) {
    teamForm.querySelector('.invalid input')?.focus();
    return;
  }

  const { consent, ...payload } = values;
  payload.showOnPublicList = consent;

  submitting = true;
  updateSubmitButton();

  try {
    const result = await api.register(payload);
    teamForm.reset();
    applySoloLayout();

    const firstName = payload.fullName.split(/\s+/)[0];
    const who = solo ? 'You are' : `Your team ${payload.teamName} is`;
    const doneMessage = result.status === 'pending'
      ? `Thank you, ${firstName}. ${who} registered. You can pay online using the "How to pay" box and send your GCash reference number, or just pay when you arrive at the event.`
      : `Thank you, ${firstName}. ${who} registered. See you on the court!`;
    doneAudio = voiceFiles[result.status === 'pending' ? 'pending' : 'confirmed'];
    showDialog({
      kind: 'success',
      title: solo ? 'You are registered!' : 'Your team is registered!',
      message: doneMessage,
      listenText: doneMessage,
      confirmText: 'Got it',
    }).then(stopSpeaking);
    playVoice(doneMessage);

    await refresh();
  } catch (err) {
    showTeamMessage(err.details.length ? err.details.join(' ') : err.message, 'bad');
    if (err.status === 409) await refresh();
  } finally {
    submitting = false;
    updateSubmitButton();
  }
});

/* =====================================================================
   6b. SEND A GCASH REFERENCE NUMBER LATER (after paying)
   ===================================================================== */
$('ref-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const say = (text, kind) => {
    const el = $('ref-msg');
    el.textContent = text;
    el.className = 'form-msg' + (kind ? ` ${kind}` : '');
  };

  const contactNumber = $('r-contact').value.replace(/[\s-]/g, '');
  const paymentRef = $('r-ref').value.replace(/\s+/g, '');
  if (!PH_MOBILE.test(contactNumber)) return say('Enter the contact number you registered with.', 'bad');
  if (!/^\d{13}$/.test(paymentRef)) return say('Enter the 13-digit GCash reference number.', 'bad');

  const btn = $('ref-btn');
  btn.disabled = true;
  say('', '');
  try {
    const result = await api.sendReference({ contactNumber, paymentRef });
    $('ref-form').reset();
    say(result.message, 'ok');
  } catch (err) {
    say(err.details.length ? err.details.join(' ') : err.message, 'bad');
  } finally {
    btn.disabled = false;
  }
});

/* =====================================================================
   6c. BOTTOM MENU - highlights the section you are looking at
   ===================================================================== */
const navLinks = [...document.querySelectorAll('#bottom-nav a')];
let navTicking = false;

function updateBottomNav() {
  navTicking = false;
  const desktop = window.innerWidth >= 900;   // on PC the Register card is always on screen
  const visible = navLinks.filter((a) => !a.hidden && !(desktop && a.dataset.target === 'register'));
  const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
  let current = visible[0];

  visible.forEach((a) => {
    const section = $(a.dataset.target);
    if (section && section.getBoundingClientRect().top <= window.innerHeight * 0.4) current = a;
  });
  if (atBottom) current = visible[visible.length - 1];

  navLinks.forEach((a) => {
    const on = a === current;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
  });
}

window.addEventListener('scroll', () => {
  if (!navTicking) { navTicking = true; requestAnimationFrame(updateBottomNav); }
}, { passive: true });
window.addEventListener('resize', updateBottomNav);
updateBottomNav();

/* =====================================================================
   7. START
   ===================================================================== */
// The last event details are kept in the browser. The page shows them right away, then the fresh
// details from the server replace them. This way the title and countdown do not "jump" when the page opens.
const EVENT_CACHE_KEY = 'pickleball-event-cache';

function saveEventCache(event) {
  try { localStorage.setItem(EVENT_CACHE_KEY, JSON.stringify(event)); } catch { /* storage blocked or full */ }
}

function showCachedEvent() {
  try {
    const raw = localStorage.getItem(EVENT_CACHE_KEY);
    if (raw) renderEvent(JSON.parse(raw));
  } catch { /* no cache yet */ }
}

showCachedEvent();
setTimeout(() => document.documentElement.classList.add('event-ready'), 2500);   // never keep the title hidden if the server is slow
refresh().then(schedulePoll);


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