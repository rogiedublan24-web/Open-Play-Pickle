const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const adminAuth = require('../middleware/adminAuth');
const { AppError, asyncHandler } = require('../middleware/errors');
const { Registration, PLAYER_TAGS, STATUSES, ACTIVE_STATUSES } = require('../models/Registration');
const { getSlotSummary } = require('../services/slots');

// Limits spam: 20 registration attempts per IP every 15 minutes
const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many registration attempts. Please try again later.' },
});

// PUBLIC: save a new registrant
router.post(
  '/',
  createLimiter,
  asyncHandler(async (req, res) => {
    const { fullName, contactNumber, email, province, municipalityOrCity, barangay, playerTag } =
      req.body || {};

    // status is never accepted from the public: the server decides it
    if (playerTag === 'Waitlist') {
      throw new AppError('The Waitlist tag is assigned automatically when the session is full.', 400);
    }

    const doc = new Registration({
      fullName, contactNumber, email, province, municipalityOrCity, barangay, playerTag,
    });
    await doc.validate(); // checks required fields and normalizes the phone number

    const duplicate = await Registration.exists({
      contactNumber: doc.contactNumber,
      status: { $in: [...ACTIVE_STATUSES, 'waitlisted'] },
    });
    if (duplicate) throw new AppError('This contact number is already registered.', 409);

        const { isFull, waitlistFull, maxWaitlist } = await getSlotSummary();
    if (waitlistFull) {
      throw new AppError(
        `The session and the waitlist are both full (waitlist limit: ${maxWaitlist}). Please try the next open play.`,
        409
      );
    }
    if (isFull) {
      doc.status = 'waitlisted';
      doc.playerTag = 'Waitlist';
    }
    await doc.save();

    res.status(201).json({
      message: isFull
        ? 'The session is full. You have been added to the waitlist.'
        : 'Registration received. See you on the court!',
      registration: {
        id: doc._id,
        fullName: doc.fullName,
        status: doc.status,
        playerTag: doc.playerTag,
        registrationTimestamp: doc.registrationTimestamp,
      },
    });
  })
);

// ADMIN: full player list with filters and pagination
// Example: GET /api/registrations?status=confirmed&playerTag=Regular&page=1&limit=50
router.get(
  '/',
  adminAuth,
  asyncHandler(async (req, res) => {
    const { status, playerTag } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

    const filter = {};
    if (status) {
      if (!STATUSES.includes(status)) {
        throw new AppError(`status must be one of: ${STATUSES.join(', ')}`, 400);
      }
      filter.status = status;
    }
    if (playerTag) {
      if (!PLAYER_TAGS.includes(playerTag)) {
        throw new AppError(`playerTag must be one of: ${PLAYER_TAGS.join(', ')}`, 400);
      }
      filter.playerTag = playerTag;
    }

    const [total, registrations] = await Promise.all([
      Registration.countDocuments(filter),
      Registration.find(filter)
        .sort({ registrationTimestamp: 1 })
        .skip((page - 1) * limit)
        .limit(limit),
    ]);

    res.json({ total, page, limit, registrations });
  })
);

// ADMIN: update a player's status and/or tag
router.patch(
  '/:id',
  adminAuth,
  asyncHandler(async (req, res) => {
    const { status, playerTag } = req.body || {};
    if (status === undefined && playerTag === undefined) {
      throw new AppError('Provide status and/or playerTag.', 400);
    }

    const reg = await Registration.findById(req.params.id);
    if (!reg) throw new AppError('Registration not found.', 404);

    // Moving someone into a slot-holding status requires a free slot
    const wasActive = ACTIVE_STATUSES.includes(reg.status);
    const willBeActive = ACTIVE_STATUSES.includes(status ?? reg.status);
    if (willBeActive && !wasActive) {
      const { isFull } = await getSlotSummary();
      if (isFull) {
        throw new AppError('No free slots. Increase the maximum or cancel another player first.', 409);
      }
    }

    if (status !== undefined) reg.status = status;
    if (playerTag !== undefined) reg.playerTag = playerTag;
    await reg.save(); // enum validation runs here, so invalid values become a 400

    res.json({ message: 'Registration updated.', registration: reg });
  })
);

module.exports = router;
// ADMIN: permanently delete a registration
router.delete(
  '/:id',
  adminAuth,
  asyncHandler(async (req, res) => {
    const reg = await Registration.findByIdAndDelete(req.params.id);
    if (!reg) throw new AppError('Registration not found.', 404);

    res.json({ message: `${reg.fullName} was deleted.` });
  })
);