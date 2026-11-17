const router = require('express').Router();
const adminAuth = require('../middleware/adminAuth');
const { AppError, asyncHandler } = require('../middleware/errors');
const EventInfo = require('../models/EventInfo');
const { getEvent } = require('../services/event');

const TEXT_FIELDS = ['title', 'tagline', 'venue', 'address', 'fee', 'level'];
const DATE_FIELDS = ['startsAt', 'endsAt'];

// PUBLIC: event details for the public page
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await getEvent());
  })
);

// ADMIN: update any of the event details. Fields that are not sent stay as they are.
// Example body: { "venue": "Sunrise Courts", "fee": "PHP 150 per player" }
router.patch(
  '/',
  adminAuth,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const next = await getEvent();
    let changed = false;

    for (const field of TEXT_FIELDS) {
      if (body[field] === undefined) continue;
      if (typeof body[field] !== 'string') throw new AppError(`${field} must be text.`, 400);
      next[field] = body[field].trim();
      changed = true;
    }

    for (const field of DATE_FIELDS) {
      if (body[field] === undefined) continue;
      if (body[field] === null || body[field] === '') {
        next[field] = null;
      } else {
        const date = new Date(body[field]);
        if (Number.isNaN(date.getTime())) throw new AppError(`${field} is not a valid date.`, 400);
        next[field] = date;
      }
      changed = true;
    }

    if (body.notes !== undefined) {
      if (!Array.isArray(body.notes) || body.notes.some((n) => typeof n !== 'string')) {
        throw new AppError('notes must be a list of text lines.', 400);
      }
      next.notes = body.notes.map((n) => n.trim()).filter(Boolean);
      if (next.notes.length > 10) throw new AppError('notes can have at most 10 lines.', 400);
      if (next.notes.some((n) => n.length > 200)) throw new AppError('Each note must be 200 characters or less.', 400);
      changed = true;
    }

    if (!changed) throw new AppError('Nothing to update.', 400);
    if (!next.title) throw new AppError('title cannot be empty.', 400);
    if (next.startsAt && next.endsAt && new Date(next.endsAt) <= new Date(next.startsAt)) {
      throw new AppError('endsAt must be later than startsAt.', 400);
    }

    await EventInfo.findOneAndUpdate(
      { key: 'openPlay' },
      { $set: next },
      { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true }
    );

    res.json({ message: 'Event details updated.', event: await getEvent() });
  })
);

module.exports = router;