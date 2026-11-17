const mongoose = require('mongoose');

const PLAYER_TAGS = ['Bagong Manlalaro', 'Regular', 'Waitlist', 'Bisita'];
const STATUSES = ['pending', 'confirmed', 'waitlisted', 'cancelled'];
const ACTIVE_STATUSES = ['pending', 'confirmed']; // only these occupy a slot

// "0917 123 4567", "0917-123-4567", "+63 917 123 4567" -> "09171234567"
function normalizePhone(value) {
  if (typeof value !== 'string') return value;
  const cleaned = value.replace(/[\s()-]/g, '');
  return cleaned.startsWith('+63') ? '0' + cleaned.slice(3) : cleaned;
}

const registrationSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: [true, 'fullName is required'],
      trim: true,
      minlength: [2, 'fullName must be at least 2 characters'],
      maxlength: [80, 'fullName must be at most 80 characters'],
    },
    contactNumber: {
      type: String,
      required: [true, 'contactNumber is required'],
      set: normalizePhone,
      match: [/^09\d{9}$/, 'contactNumber must be a valid PH mobile number (e.g. 09171234567)'],
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'email is not valid'],
    },
    province: {
      type: String,
      required: [true, 'province is required'],
      trim: true,
      maxlength: 60,
    },
    municipalityOrCity: {
      type: String,
      required: [true, 'municipalityOrCity is required'],
      trim: true,
      maxlength: 60,
    },
    barangay: {
      type: String,
      required: [true, 'barangay is required'],
      trim: true,
      maxlength: 60,
    },
    playerTag: {
      type: String,
      enum: { values: PLAYER_TAGS, message: `playerTag must be one of: ${PLAYER_TAGS.join(', ')}` },
      default: 'Bagong Manlalaro',
    },
    status: {
      type: String,
      enum: { values: STATUSES, message: `status must be one of: ${STATUSES.join(', ')}` },
      default: 'pending',
    },
    registrationTimestamp: {
      type: Date,
      default: Date.now,
      immutable: true, // cannot be changed after creation
    },
  },
  { versionKey: false }
);

registrationSchema.index({ status: 1, registrationTimestamp: 1 });
registrationSchema.index({ contactNumber: 1 });

const Registration = mongoose.model('Registration', registrationSchema);

module.exports = { Registration, PLAYER_TAGS, STATUSES, ACTIVE_STATUSES };