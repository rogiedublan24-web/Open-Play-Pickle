const mongoose = require('mongoose');

// One document, key = "openPlay", stores the maximum number of players
const settingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    maxPlayers: { type: Number, required: true, min: 1, max: 200 },
  },
  { versionKey: false }
);

module.exports = mongoose.model('Setting', settingSchema);