const crypto = require('crypto');
const { AppError } = require('./errors');

// Hash both values so they have equal length, then compare in constant time
const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();

module.exports = function adminAuth(req, res, next) {
  const provided = req.get('x-admin-key') || '';
  const valid = crypto.timingSafeEqual(digest(provided), digest(process.env.ADMIN_KEY));

  if (!valid) return next(new AppError('Unauthorized: invalid or missing admin key.', 401));
  next();
};