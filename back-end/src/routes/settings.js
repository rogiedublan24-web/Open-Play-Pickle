const router = require('express').Router();
const adminAuth = require('../middleware/adminAuth');
const { AppError, asyncHandler } = require('../middleware/errors');
const Setting = require('../models/Setting');
const { Registration, ACTIVE_STATUSES } = require('../models/Registration');
const { getSlotSummary } = require('../services/slots');

// ADMIN: change the maximum number of players
router.patch(
  '/max-players',
  adminAuth,
  asyncHandler(async (req, res) => {
    const maxPlayers = req.body?.maxPlayers;
    if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 200) {
      throw new AppError('maxPlayers must be a whole number from 1 to 200.', 400);
    }

    const occupied = await Registration.countDocuments({ status: { $in: ACTIVE_STATUSES } });
    if (maxPlayers < occupied) {
      throw new AppError(
        `Cannot set below the ${occupied} players who currently hold a slot. Cancel or move some players first.`,
        409
      );
    }

    await Setting.findOneAndUpdate(
      { key: 'openPlay' },
      { maxPlayers },
      { upsert: true, returnDocument: 'after', runValidators: true }
    );

    res.json({ message: 'Maximum players updated.', ...(await getSlotSummary()) });
  })
);

module.exports = router;