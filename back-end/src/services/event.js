const EventInfo = require('../models/EventInfo');

// Shown until the admin saves the event details for the first time
const DEFAULT_EVENT = {
  title: 'Pickleball Open Play',
  tagline: 'No partner needed. Show up, sign up, and play.',
  startsAt: null,
  endsAt: null,
  venue: '',
  address: '',
  fee: '',
  level: 'All levels',
  notes: [],
};

const FIELDS = Object.keys(DEFAULT_EVENT);

// Returns only the public fields (no _id, no key)
async function getEvent() {
  const doc = await EventInfo.findOne({ key: 'openPlay' }).lean();
  if (!doc) return { ...DEFAULT_EVENT };

  const event = {};
  for (const field of FIELDS) event[field] = doc[field] ?? DEFAULT_EVENT[field];
  return event;
}

module.exports = { DEFAULT_EVENT, getEvent };