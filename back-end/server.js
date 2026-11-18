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
const MAX_WAITLIST = numberFromEnv('MAX_WAITLIST', 5);

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
const STATUSES = ['pending', 'confirmed', 'waitlisted', 'cancelled'];
const TAGS = ['Bagong Manlalaro', 'Regular', 'Waitlist', 'Bisita'];
const OCCUPYING = ['pending', 'confirmed'];   // statuses that take up a slot
const NEW_REGISTRATION_STATUS = 'confirmed';    // change to 'confirmed' to auto-confirm new players

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
app.use(express.json());

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
  registrationTimestamp: { type: Date, default: Date.now },
});
const Registration = mongoose.model('Registration', registrationSchema);

// One document with the settings (max players)
const settingSchema = new mongoose.Schema({
  key: { type: String, default: 'main', unique: true },
  maxPlayers: { type: Number, default: DEFAULT_MAX_PLAYERS, min: 1 },
});
const Setting = mongoose.model('Setting', settingSchema);

// One document with the event details shown on the public page
const eventSchema = new mongoose.Schema({
  key: { type: String, default: 'main', unique: true },
  title: { type: String, default: 'Pickleball Open Play' },
  level: { type: String, default: '' },
  tagline: { type: String, default: '' },
  startsAt: { type: Date, default: null },
  endsAt: { type: Date, default: null },
  venue: { type: String, default: '' },
  address: { type: String, default: '' },
  fee: { type: String, default: '' },
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

// The slot summary used by both the public page and the admin page
async function getSlots() {
  const settings = await getSettings();
  const [occupied, waitlisted] = await Promise.all([
    Registration.countDocuments({ status: { $in: OCCUPYING } }),
    Registration.countDocuments({ status: 'waitlisted' }),
  ]);
  const isFull = occupied >= settings.maxPlayers;
  return {
    maxPlayers: settings.maxPlayers,
    occupied,
    availableSlots: Math.max(settings.maxPlayers - occupied, 0),
    isFull,
    waitlisted,
    maxWaitlist: MAX_WAITLIST,
    waitlistFull: isFull && waitlisted >= MAX_WAITLIST,
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
    const players = await Registration
      .find({ status: { $in: OCCUPYING }, showOnPublicList: true })
      .sort({ registrationTimestamp: 1 })
      .lean();
    res.json(players.map((p) => ({
      displayName: publicName(p.fullName),
      playerTag: p.playerTag,
    })));
  } catch (err) { next(err); }
});

// Register a player (the same handler answers on three common paths)
async function createRegistration(req, res, next) {
  try {
    const b = req.body;
    if (!b.fullName || !String(b.fullName).trim() || !b.contactNumber || !String(b.contactNumber).trim()) {
      return res.status(400).json({
        message: 'Please fix the highlighted fields.',
        details: ['Full name and contact number are required.'],
      });
    }

    const duplicate = await Registration.findOne({
      contactNumber: String(b.contactNumber).trim(),
      status: { $ne: 'cancelled' },
    });
    if (duplicate) {
      return res.status(409).json({ message: 'This contact number is already registered.' });
    }

    // Slots left -> pending. Full -> waitlist (up to MAX_WAITLIST). Both full -> reject.
    const slots = await getSlots();
    let status = NEW_REGISTRATION_STATUS;
    if (slots.availableSlots <= 0) {
      if (slots.waitlisted >= MAX_WAITLIST) {
        return res.status(409).json({ message: 'The event and the waitlist are both full.' });
      }
      status = 'waitlisted';
    }

    const registration = await Registration.create({
      fullName: b.fullName,
      contactNumber: b.contactNumber,
      email: b.email,
      province: b.province,
      municipalityOrCity: b.municipalityOrCity,
      barangay: b.barangay,
      playerTag: TAGS.includes(b.playerTag) ? b.playerTag : 'Bagong Manlalaro',
      showOnPublicList: Boolean(b.showOnPublicList ?? b.consent ?? b.publicConsent),
      status,
    });

    res.status(201).json({
      message: status === 'waitlisted'
        ? 'The event is full. You were added to the waitlist.'
        : 'Your slot is reserved!',
      status,
      registration,
      slots: await getSlots(),
    });
  } catch (err) { next(err); }
}
app.post(['/api/register', '/api/registrations', '/api/registrants'], createRegistration);

/* ---------- Admin routes (need the x-admin-key header) ---------- */

// List with filters and pages -> { total, page, limit, registrations }
app.get('/api/admin/registrants', requireAdmin, async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);

    const filter = {};
    if (STATUSES.includes(req.query.status)) filter.status = req.query.status;
    if (TAGS.includes(req.query.playerTag)) filter.playerTag = req.query.playerTag;

    const [total, registrations] = await Promise.all([
      Registration.countDocuments(filter),
      Registration.find(filter)
        .sort({ registrationTimestamp: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);
    res.json({ total, page, limit, registrations });
  } catch (err) { next(err); }
});

// Change a player's status and/or tag -> { message, registration }
app.patch('/api/admin/registrants/:id', requireAdmin, async (req, res, next) => {
  try {
    const { status, playerTag } = req.body;
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
      if (registration.status !== 'waitlisted' && status === 'waitlisted' && slots.waitlisted >= MAX_WAITLIST) {
        return res.status(409).json({ message: 'The waitlist is full.' });
      }
      registration.status = status;
    }

    if (playerTag !== undefined) {
      if (!TAGS.includes(playerTag)) return res.status(400).json({ message: 'Invalid player tag.' });
      registration.playerTag = playerTag;
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
    const value = Number(req.body.maxPlayers);
    if (!Number.isInteger(value) || value < 1 || value > 200) {
      return res.status(400).json({ message: 'Max players must be a whole number from 1 to 200.' });
    }
    await Setting.findOneAndUpdate(
      { key: 'main' },
      { $set: { maxPlayers: value } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ ...(await getSlots()), message: 'Max players updated.' });
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

    ['title', 'level', 'tagline', 'venue', 'address'].forEach((f) => {
      if (b[f] !== undefined) update[f] = String(b[f]).trim();
    });
    if (b.fee !== undefined) update.fee = String(b.fee).trim();
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

    if (update.title !== undefined && !update.title) problems.push('The title cannot be empty.');
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
  
  // Dito nakalagay ang console.error para lumitaw sa Vercel Logs
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