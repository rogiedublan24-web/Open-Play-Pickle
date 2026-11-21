require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_KEY = process.env.ADMIN_KEY;

// Reads a number from .env, falls back to a default if missing or invalid
function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
const DEFAULT_MAX_PLAYERS = numberFromEnv('DEFAULT_MAX_PLAYERS', 16);

// CORS_ORIGIN in .env is a comma-separated list of allowed origins
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const isProduction = process.env.NODE_ENV === 'production';

if (!MONGODB_URI || !ADMIN_KEY) {
  console.error('Missing MONGODB_URI or ADMIN_KEY in your environment settings.');
  process.exit(1);
}

// Must match the lists in admin.js
const STATUSES = ['pending', 'confirmed', 'cancelled'];
const TAGS = ['Bagong Manlalaro', 'Regular', 'Bisita'];
const OCCUPYING = ['pending', 'confirmed'];   // statuses that take up a slot
const NEW_REGISTRATION_STATUS = 'confirmed';    // status given to new players when slots are free
const MODES = ['open', 'team'];                 // 'open' = Open Play (single players), 'team' = By Team (2 players per team)
const DEFAULT_MAX_TEAMS = numberFromEnv('DEFAULT_MAX_TEAMS', 8);

const app = express();

/* ---------- Middleware ---------- */

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    // While developing, also allow localhost / 127.0.0.1 on any port
    if (!isProduction && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return cb(null, true);
    }
    cb(new Error('Not allowed by CORS'));
  },
}));
app.use(express.json({ limit: '400kb' }));   // bigger limit: the admin can upload a small QR image

// Limit wrong-key attempts on the admin routes (helps against key guessing).
// Only 401 (wrong key) responses count, so normal admin work is never blocked.
app.set('trust proxy', 1);   // needed on Vercel so the real visitor IP is used
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,                                   // 15 minutes
  limit: 5,                                                   // max wrong attempts per IP in that time
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => res.statusCode !== 401, // count only wrong-key responses
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many wrong attempts. Please try again in 15 minutes.' },
});
app.use('/api/admin', adminLimiter);
app.use('/api/settings', adminLimiter);

// Connect to MongoDB once, and reuse the connection on later requests
let dbConnection;
function connectDb() {
  if (!dbConnection) dbConnection = mongoose.connect(MONGODB_URI);
  return dbConnection;
}
app.use(async (req, res, next) => {
  try { await connectDb(); next(); } catch (err) { next(err); }
});

// The admin page sends the key in the "x-admin-key" header
function requireAdmin(req, res, next) {
  if (req.header('x-admin-key') !== ADMIN_KEY) {
    return res.status(401).json({ message: 'Invalid admin key.' });
  }
  next();
}

/* ---------- Models ---------- */

const registrationSchema = new mongoose.Schema({
  fullName: { type: String, required: true, trim: true, maxlength: 80 },
  contactNumber: { type: String, required: true, trim: true, maxlength: 20 },
  email: { type: String, trim: true, lowercase: true, default: '' },
  province: { type: String, trim: true, default: '' },
  municipalityOrCity: { type: String, trim: true, default: '' },
  barangay: { type: String, trim: true, default: '' },
  playerTag: { type: String, enum: TAGS, default: 'Bagong Manlalaro' },
  status: { type: String, enum: STATUSES, default: NEW_REGISTRATION_STATUS },
  showOnPublicList: { type: Boolean, default: false },
  paid: { type: Boolean, default: false },   // only the admin can change this
  paymentRef: { type: String, trim: true, default: '' },   // 13-digit GCash reference number
  kind: { type: String, enum: ['player', 'team'], default: 'player' },   // older records have no kind = player
  teamName: { type: String, trim: true, default: '', maxlength: 40 },    // By Team only
  partnerName: { type: String, trim: true, default: '', maxlength: 80 }, // By Team only: Player 2 (fullName + contactNumber = Player 1, the captain)
  registrationTimestamp: { type: Date, default: Date.now },
});
const Registration = mongoose.model('Registration', registrationSchema);

// One document with the settings (max players)
const settingSchema = new mongoose.Schema({
  key: { type: String, default: 'main', unique: true },
  maxPlayers: { type: Number, default: DEFAULT_MAX_PLAYERS, min: 1 },
  maxTeams: { type: Number, default: DEFAULT_MAX_TEAMS, min: 1 },
});
const Setting = mongoose.model('Setting', settingSchema);

// One document with the event details shown on the public page
const eventSchema = new mongoose.Schema({
  key: { type: String, default: 'main', unique: true },
  title: { type: String, default: 'Pickleball Open Play' },
  mode: { type: String, enum: MODES, default: 'open' },   // which registration is active
  level: { type: String, default: '' },
  tagline: { type: String, default: '' },
  startsAt: { type: Date, default: null },
  endsAt: { type: Date, default: null },
  venue: { type: String, default: '' },
  address: { type: String, default: '' },
  fee: { type: String, default: '' },
  gcashName: { type: String, default: '' },
  gcashNumber: { type: String, default: '' },
  gcashQr: { type: String, default: '' },   // small image saved as text (data URL)
  notes: { type: [String], default: [] },
});
const EventInfo = mongoose.model('EventInfo', eventSchema);

/* ---------- Helpers ---------- */

const getSettings = () =>
  Setting.findOneAndUpdate({ key: 'main' }, { $setOnInsert: { key: 'main' } },
    { upsert: true, new: true, setDefaultsOnInsert: true });

const getEvent = () =>
  EventInfo.findOneAndUpdate({ key: 'main' }, { $setOnInsert: { key: 'main' } },
    { upsert: true, new: true, setDefaultsOnInsert: true });

// Only the registrations of the active mode are used. The other list is hidden, never deleted.
const kindFilter = (mode) => (mode === 'team' ? { kind: 'team' } : { kind: { $ne: 'team' } });

// The slot summary used by both the public page and the admin page
// In By Team mode, one slot = one team and "max" = max teams.
async function getSlots() {
  const [settings, event] = await Promise.all([getSettings(), getEvent()]);
  const mode = event.mode === 'team' ? 'team' : 'open';
  const max = mode === 'team' ? (settings.maxTeams || DEFAULT_MAX_TEAMS) : settings.maxPlayers;
  const occupied = await Registration.countDocuments({ status: { $in: OCCUPYING }, ...kindFilter(mode) });
  return {
    mode,
    max,
    maxPlayers: max,   // kept with this name so the older front-end code still works
    occupied,
    availableSlots: Math.max(max - occupied, 0),
    isFull: occupied >= max,
  };
}

// "Juan Dela Cruz" -> "Juan C."
function publicName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/* ---------- Public routes ---------- */

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/slots', async (req, res, next) => {
  try { res.json(await getSlots()); } catch (err) { next(err); }
});

app.get('/api/event', async (req, res, next) => {
  try { res.json(await getEvent()); } catch (err) { next(err); }
});

// Public player list: only players who agreed, first name + last initial only
app.get('/api/players', async (req, res, next) => {
  try {
    const event = await getEvent();
    const mode = event.mode === 'team' ? 'team' : 'open';
    const players = await Registration
      .find({ status: { $in: OCCUPYING }, showOnPublicList: true, ...kindFilter(mode) })
      .sort({ registrationTimestamp: 1 })
      .lean();
    res.json(players.map((p) => ({
      // By Team: only the team name is shown
      displayName: mode === 'team' ? (p.teamName || publicName(p.fullName)) : publicName(p.fullName),
      playerTag: p.playerTag,
      paid: p.paid === true,
      // Paid = the admin checked it. Pending = a reference number was sent, waiting for the admin. Unpaid = nothing sent yet.
      // (the reference number itself is never sent to the public page)
      payment: p.paid === true ? 'paid' : (p.paymentRef ? 'pending' : 'unpaid'),
    })));
  } catch (err) { next(err); }
});

// Register a player (the same handler answers on three common paths)
async function createRegistration(req, res, next) {
  try {
    const b = req.body;
    const event = await getEvent();
    const isTeam = event.mode === 'team';   // the active mode decides, not the browser
    const kind = isTeam ? 'team' : 'player';
    const teamName = String(b.teamName || '').trim();
    const partnerName = String(b.partnerName || '').trim();

    if (!b.fullName || !String(b.fullName).trim() || !b.contactNumber || !String(b.contactNumber).trim()) {
      return res.status(400).json({
        message: 'Please fix the highlighted fields.',
        details: [isTeam ? 'Player 1 name and contact number are required.' : 'Full name and contact number are required.'],
      });
    }
    if (isTeam) {
      const problems = [];
      if (!teamName) problems.push('Team name is required.');
      if (teamName.length > 40) problems.push('Team name is too long (40 characters max).');
      if (!partnerName) problems.push('Player 2 name is required.');
      if (!String(b.municipalityOrCity || '').trim() || !String(b.barangay || '').trim()) {
        problems.push('Municipality / City and barangay are required.');
      }
      if (problems.length) {
        return res.status(400).json({ message: 'Please fix the highlighted fields.', details: problems });
      }
    }

    // Registration closes when the event starts (the countdown on the page reaches zero)
    if (event.startsAt && Date.now() >= new Date(event.startsAt).getTime()) {
      return res.status(403).json({ message: 'Registration is closed. The event has already started.' });
    }

    const duplicate = await Registration.findOne({
      contactNumber: String(b.contactNumber).trim(),
      status: { $ne: 'cancelled' },
      ...kindFilter(event.mode),
    });
    if (duplicate) {
      return res.status(409).json({ message: isTeam ? 'This contact number already has a team.' : 'This contact number is already registered.' });
    }
    if (isTeam) {
      const escaped = teamName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const nameUsed = await Registration.findOne({
        kind: 'team',
        status: { $ne: 'cancelled' },
        teamName: new RegExp(`^${escaped}$`, 'i'),
      });
      if (nameUsed) {
        return res.status(409).json({ message: 'That team name is already taken. Please choose another one.' });
      }
    }

    // When GCash is set up (number or QR), new players wait for payment.
    // The reference number is optional here: the player can send it later after paying.
    const paymentRequired = Boolean(event.gcashNumber || event.gcashQr);
    const paymentRef = String(b.paymentRef || '').replace(/\s+/g, '');
    if (paymentRequired && paymentRef) {
      if (!/^\d{13}$/.test(paymentRef)) {
        return res.status(400).json({
          message: 'Please fix the highlighted fields.',
          details: ['The GCash reference number must be 13 digits.'],
        });
      }
      const refUsed = await Registration.findOne({ paymentRef, status: { $ne: 'cancelled' } });
      if (refUsed) {
        return res.status(409).json({ message: 'This GCash reference number was already used.' });
      }
    }

    // Slots left -> pending (waiting for payment) or confirmed. No slots left -> reject.
    const slots = await getSlots();
    if (slots.availableSlots <= 0) {
      return res.status(409).json({ message: 'Sorry, all slots are taken.' });
    }
    const status = paymentRequired ? 'pending' : NEW_REGISTRATION_STATUS;

    const registration = await Registration.create({
      fullName: b.fullName,
      contactNumber: b.contactNumber,
      email: b.email,
      province: b.province,
      municipalityOrCity: b.municipalityOrCity,
      barangay: b.barangay,
      playerTag: TAGS.includes(b.playerTag) ? b.playerTag : 'Bagong Manlalaro',
      showOnPublicList: Boolean(b.showOnPublicList ?? b.consent ?? b.publicConsent),
      paymentRef: paymentRequired ? paymentRef : '',
      kind,
      teamName: isTeam ? teamName : '',
      partnerName: isTeam ? partnerName : '',
      status,
    });

    res.status(201).json({
      message: status === 'pending'
        ? (isTeam ? 'Your team slot is reserved. It will be confirmed after your payment is checked.' : 'Your slot is reserved. It will be confirmed after your payment is checked.')
        : (isTeam ? 'Your team slot is reserved!' : 'Your slot is reserved!'),
      status,
      registration,
      slots: await getSlots(),
    });
  } catch (err) { next(err); }
}
app.post(['/api/register', '/api/registrations', '/api/registrants'], createRegistration);

// A player who already registered sends the GCash reference number after paying
const refLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,                       // max 10 tries per IP in 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many tries. Please try again in a few minutes.' },
});
app.post('/api/payment-ref', refLimiter, async (req, res, next) => {
  try {
    const contactNumber = String(req.body.contactNumber || '').replace(/[\s-]/g, '');
    const paymentRef = String(req.body.paymentRef || '').replace(/\s+/g, '');

    if (!contactNumber || !/^\d{13}$/.test(paymentRef)) {
      return res.status(400).json({
        message: 'Please check your details.',
        details: ['Enter your contact number and the 13-digit GCash reference number.'],
      });
    }

    // 09171234567, +639171234567 and 639171234567 are the same number: try all three
    const last10 = contactNumber.replace(/\D/g, '').slice(-10);
    const numberFormats = [contactNumber, `0${last10}`, `+63${last10}`, `63${last10}`];
    const event = await getEvent();
    const registration = await Registration.findOne({
      contactNumber: { $in: numberFormats },
      status: { $ne: 'cancelled' },
      ...kindFilter(event.mode),
    });
    if (!registration) {
      return res.status(404).json({ message: 'We could not find that number. Check that it is the same number you registered with, or message the organizer with your GCash receipt.' });
    }
    if (registration.paid) {
      return res.status(409).json({ message: 'Your payment is already confirmed. Thank you!' });
    }

    const refUsed = await Registration.findOne({
      paymentRef,
      _id: { $ne: registration._id },
      status: { $ne: 'cancelled' },
    });
    if (refUsed) {
      return res.status(409).json({ message: 'This GCash reference number was already used.' });
    }

    registration.paymentRef = paymentRef;
    await registration.save();
    res.json({ message: 'Thank you! We received your reference number. The organizer will confirm your payment.' });
  } catch (err) { next(err); }
});

/* ---------- Admin routes (need the x-admin-key header) ---------- */

// List with filters and pages -> { total, page, limit, registrations }
app.get('/api/admin/registrants', requireAdmin, async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);

    const event = await getEvent();
    const mode = event.mode === 'team' ? 'team' : 'open';
    const filter = { ...kindFilter(mode) };   // only the active mode's list is shown
    if (STATUSES.includes(req.query.status)) filter.status = req.query.status;
    if (TAGS.includes(req.query.playerTag)) filter.playerTag = req.query.playerTag;
    if (req.query.paid === 'true') filter.paid = true;
    if (req.query.paid === 'false') filter.paid = { $ne: true };   // also matches older records without the field

    // Search box: matches name, number, email, address, tag or reference. Capital or small letters both work.
    const q = String(req.query.q || '').trim().slice(0, 60);
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');   // the text is searched as plain text, never as a pattern
      const or = ['fullName', 'contactNumber', 'email', 'province', 'municipalityOrCity', 'barangay', 'playerTag', 'paymentRef', 'teamName', 'partnerName']
        .map((f) => ({ [f]: rx }));
      const digits = q.replace(/\D/g, '');
      if (digits.length >= 4) {                       // 0917... / +63917... / 63917... all match the same number
        or.push({ contactNumber: new RegExp(digits.replace(/^(63|0)/, '')) });
      }
      filter.$or = or;
    }

    const [total, registrations, occupying, paidOccupying] = await Promise.all([
      Registration.countDocuments(filter),
      Registration.find(filter)
        .sort({ registrationTimestamp: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Registration.countDocuments({ status: { $in: OCCUPYING }, ...kindFilter(mode) }),
      Registration.countDocuments({ status: { $in: OCCUPYING }, paid: true, ...kindFilter(mode) }),
    ]);
    // How many registrations are hidden because they belong to the other mode (for the switch warning)
    const hiddenCount = await Registration.countDocuments({ status: { $in: OCCUPYING }, ...kindFilter(mode === 'team' ? 'open' : 'team') });
    res.json({
      mode,
      hiddenCount,
      total,
      page,
      limit,
      registrations,
      paidCount: paidOccupying,               // players holding a slot who already paid
      unpaidCount: occupying - paidOccupying, // players holding a slot who have not paid yet
    });
  } catch (err) { next(err); }
});

// Change a player's status, tag and/or payment -> { message, registration }
app.patch('/api/admin/registrants/:id', requireAdmin, async (req, res, next) => {
  try {
    const { status, playerTag, paid } = req.body;
    const registration = await Registration.findById(req.params.id);
    if (!registration) return res.status(404).json({ message: 'Registrant not found.' });

    if (status !== undefined) {
      if (!STATUSES.includes(status)) return res.status(400).json({ message: 'Invalid status.' });

      const wasOccupying = OCCUPYING.includes(registration.status);
      const willOccupy = OCCUPYING.includes(status);
      const slots = await getSlots();

      if (!wasOccupying && willOccupy && slots.availableSlots <= 0) {
        return res.status(409).json({ message: 'There are no open slots left. Raise the max players first.' });
      }
      registration.status = status;
    }

    if (playerTag !== undefined) {
      if (!TAGS.includes(playerTag)) return res.status(400).json({ message: 'Invalid player tag.' });
      registration.playerTag = playerTag;
    }

    if (paid !== undefined) {
      if (typeof paid !== 'boolean') return res.status(400).json({ message: 'Invalid payment value.' });
      registration.paid = paid;
    }

    await registration.save();
    res.json({ message: 'Registration updated.', registration });
  } catch (err) { next(err); }
});

// Delete a registration -> { message }
app.delete('/api/admin/registrants/:id', requireAdmin, async (req, res, next) => {
  try {
    const registration = await Registration.findByIdAndDelete(req.params.id);
    if (!registration) return res.status(404).json({ message: 'Registrant not found.' });
    res.json({ message: 'Registration deleted.' });
  } catch (err) { next(err); }
});

// Change max players -> slot summary + message
app.patch('/api/settings/max-players', requireAdmin, async (req, res, next) => {
  try {
    const forTeams = req.body.maxTeams !== undefined;   // By Team sends maxTeams, Open Play sends maxPlayers
    const value = Number(forTeams ? req.body.maxTeams : req.body.maxPlayers);
    if (!Number.isInteger(value) || value < 1 || value > 200) {
      return res.status(400).json({ message: `${forTeams ? 'Max teams' : 'Max players'} must be a whole number from 1 to 200.` });
    }
    await Setting.findOneAndUpdate(
      { key: 'main' },
      { $set: forTeams ? { maxTeams: value } : { maxPlayers: value } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ ...(await getSlots()), message: forTeams ? 'Max teams updated.' : 'Max players updated.' });
  } catch (err) { next(err); }
});

// Event details (venue, fee, date, notes...)
app.get('/api/admin/event', requireAdmin, async (req, res, next) => {
  try { res.json(await getEvent()); } catch (err) { next(err); }
});

app.patch('/api/admin/event', requireAdmin, async (req, res, next) => {
  try {
    const b = req.body;
    const update = {};
    const problems = [];

    ['title', 'level', 'tagline', 'venue', 'address', 'gcashName', 'gcashNumber'].forEach((f) => {
      if (b[f] !== undefined) update[f] = String(b[f]).trim();
    });
    if (b.fee !== undefined) update.fee = String(b.fee).trim();
    if (b.mode !== undefined) {
      if (MODES.includes(b.mode)) update.mode = b.mode;
      else problems.push('Registration type must be Open Play or By Team.');
    }
    if (b.notes !== undefined) {
      update.notes = Array.isArray(b.notes)
        ? b.notes.map((n) => String(n).trim()).filter(Boolean)
        : [];
    }
    ['startsAt', 'endsAt'].forEach((f) => {
      if (b[f] === undefined) return;
      if (b[f] === null || b[f] === '') { update[f] = null; return; }
      const d = new Date(b[f]);
      if (Number.isNaN(d.getTime())) problems.push(`${f} is not a valid date.`);
      else update[f] = d;
    });

    // GCash QR image: a small png/jpeg/webp saved as a data URL ('' removes it)
    if (b.gcashQr !== undefined) {
      const qr = String(b.gcashQr);
      if (qr === '') update.gcashQr = '';
      else if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(qr) || qr.length > 300000) {
        problems.push('The GCash QR must be a small PNG, JPG or WEBP image.');
      } else update.gcashQr = qr;
    }

    if (update.title !== undefined && !update.title) problems.push('The title cannot be empty.');
    if (update.gcashName && update.gcashName.length > 60) problems.push('The GCash name is too long (60 characters max).');
    if (update.gcashNumber && !/^[0-9+\s-]{7,20}$/.test(update.gcashNumber)) {
      problems.push('The GCash number can only have digits, spaces, + and - (7 to 20 characters).');
    }
    if (problems.length) {
      return res.status(400).json({ message: 'Please fix the highlighted fields.', details: problems });
    }

    const event = await EventInfo.findOneAndUpdate(
      { key: 'main' },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ message: 'Event details saved.', event });
  } catch (err) { next(err); }
});

/* ---------- Errors ---------- */

app.use((req, res) => res.status(404).json({ message: 'Route not found.' }));

app.use((err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ message: 'This origin is not allowed.' });
  }
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      message: 'Please fix the highlighted fields.',
      details: Object.values(err.errors).map((e) => e.message),
    });
  }
  if (err.name === 'CastError') {
    return res.status(400).json({ message: 'Invalid ID.' });
  }

  // Logged so the real cause shows up in the Vercel Logs
  console.error(err);
  res.status(500).json({ message: 'Something went wrong on the server.' });
});

/* ---------- Start ---------- */

module.exports = app;   // Vercel uses this export

// Only listen on a port when you run "node server.js" on your own computer
if (require.main === module) {
  connectDb()
    .then(() => {
      console.log('MongoDB connected');
      app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
    })
    .catch((err) => {
      console.error('Could not connect to MongoDB:', err.message);
      process.exit(1);
    });
}