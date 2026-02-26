const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    unique: true,
    required: true,
    trim: true,
    lowercase: true
  },
  name: {
    type: String,
    default: "",
    trim: true
  },
  password: {
    type: String,
    required: true
  }
});

module.exports = mongoose.model("User", userSchema);
