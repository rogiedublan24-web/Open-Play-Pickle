const router = require('express').Router();
const { asyncHandler } = require('../middleware/errors');
const { Registration, ACTIVE_STATUSES } = require('../models/Registration');
const { getSlotSummary } = require('../services/slots');

// "Maria Santos" -> "Maria S."
function toDisplayName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  const initial = parts.length > 1 ? ` ${parts[parts.length - 1][0].toUpperCase()}.` : '';
  return parts[0] + initial;
}

// PUBLIC: slot counts for the live display
router.get(
  '/slots',
  asyncHandler(async (req, res) => {
    res.json(await getSlotSummary());
  })
);

// PUBLIC: player list with masked names only (no phone, email, or address)
router.get(
  '/players',
  asyncHandler(async (req, res) => {
    const players = await Registration.find({ status: { $in: ACTIVE_STATUSES } })
      .sort({ registrationTimestamp: 1 })
      .select('fullName playerTag')
      .lean();

    res.json(players.map((p) => ({ displayName: toDisplayName(p.fullName), playerTag: p.playerTag })));
  })
);

module.exports = router;