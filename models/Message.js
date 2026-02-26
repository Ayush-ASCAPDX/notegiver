const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema({
  from: {
    type: String,
    required: true
  },
  to: {
    type: String,
    required: true
  },
  message: {
    type: String,
    default: ""
  },
  type: {
    type: String,
    enum: ["text", "image", "video"],
    default: "text"
  },
  mediaUrl: {
    type: String,
    default: ""
  },
  seen: {
    type: Boolean,
    default: false
  },
  edited: {
    type: Boolean,
    default: false
  },
  editedAt: {
    type: Date,
    default: null
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model("Message", messageSchema);
