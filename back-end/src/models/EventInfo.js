const mongoose = require('mongoose');

// One document (key = "openPlay") with the event details shown on the public page
const eventInfoSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    title: { type: String, required: true, trim: true, maxlength: 100 },
    tagline: { type: String, trim: true, maxlength: 200, default: '' },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    venue: { type: String, trim: true, maxlength: 120, default: '' },
    address: { type: String, trim: true, maxlength: 120, default: '' },
    fee: { type: String, trim: true, maxlength: 60, default: '' },
    level: { type: String, trim: true, maxlength: 60, default: '' },
    notes: [{ type: String, trim: true, maxlength: 200 }],
  },
  { versionKey: false }
);

module.exports = mongoose.model('EventInfo', eventInfoSchema);