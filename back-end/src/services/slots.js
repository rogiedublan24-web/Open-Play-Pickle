const Setting = require('../models/Setting');
const { Registration, ACTIVE_STATUSES } = require('../models/Registration');

// The most people allowed on the waitlist. Change MAX_WAITLIST in .env to adjust it.
const MAX_WAITLIST = Number(process.env.MAX_WAITLIST) || 5;

// Reads the saved maximum; creates it from DEFAULT_MAX_PLAYERS (16) on first use
async function getMaxPlayers() {
  const fallback = Number(process.env.DEFAULT_MAX_PLAYERS) || 16;
  const setting = await Setting.findOneAndUpdate(
    { key: 'openPlay' },
    { $setOnInsert: { maxPlayers: fallback } },
    { upsert: true, returnDocument: 'after', runValidators: true }
  );
  return setting.maxPlayers;
}

async function getSlotSummary() {
  const [maxPlayers, occupied, waitlisted] = await Promise.all([
    getMaxPlayers(),
    Registration.countDocuments({ status: { $in: ACTIVE_STATUSES } }),
    Registration.countDocuments({ status: 'waitlisted' }),
  ]);

  const availableSlots = Math.max(maxPlayers - occupied, 0);
  const isFull = availableSlots === 0;

  return {
    maxPlayers,
    occupied,
    availableSlots,
    waitlisted,
    maxWaitlist: MAX_WAITLIST,
    isFull,
    waitlistFull: isFull && waitlisted >= MAX_WAITLIST, // no more registrations accepted
  };
}

module.exports = { getMaxPlayers, getSlotSummary, MAX_WAITLIST };