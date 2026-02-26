const path = require("path");
require("dotenv").config();
const express = require("express");
const http = require("http");
const net = require("net");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const Message = require("./models/Message");
const User = require("./models/User");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const JWT_SECRET = process.env.JWT_SECRET || "change_this_secret";
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGODB_URL;

function validateRuntimeConfig() {
  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction && (!process.env.JWT_SECRET || process.env.JWT_SECRET === "change_this_secret")) {
    throw new Error("JWT_SECRET is required in production. Set a strong JWT_SECRET in your environment variables.");
  }
}

async function connectToMongo() {
  if (!MONGODB_URI) {
    throw new Error("MongoDB connection string is missing. Set MONGODB_URI (or MONGODB_URL) in environment variables.");
  }

  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 10000
  });

  console.log("MongoDB Connected");
}

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));
app.use(express.static("public", { index: false }));

function createToken(user) {
  return jwt.sign(
    {
      username: user.username,
      name: user.name
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function socketAuth(socket, next) {
  const token = socket.handshake.auth?.token;

  if (!token) {
    return next(new Error("Unauthorized"));
  }

  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (error) {
    return next(new Error("Invalid token"));
  }
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/register", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "register.html"));
});

app.get("/chat", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/settings", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "settings.html"));
});

app.get("/video", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "video.html"));
});

app.get("/health", (req, res) => {
  const mongoState = mongoose.connection.readyState === 1 ? "connected" : "disconnected";
  res.json({ ok: true, mongo: mongoState });
});

app.post("/api/register", async (req, res) => {
  try {
    const username = (req.body.username || "").trim().toLowerCase();
    const password = req.body.password || "";
    const name = (req.body.name || "").trim();

    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }

    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(409).json({ error: "Username already exists" });
    }

    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({ username, name: name || username, password: hashed });

    const token = createToken(user);
    return res.status(201).json({
      token,
      user: { username: user.username, name: user.name }
    });
  } catch (error) {
    return res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const username = (req.body.username || "").trim().toLowerCase();
    const password = req.body.password || "";

    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = createToken(user);
    return res.json({
      token,
      user: { username: user.username, name: user.name }
    });
  } catch (error) {
    return res.status(500).json({ error: "Login failed" });
  }
});

app.get("/api/me", authMiddleware, async (req, res) => {
  const user = await User.findOne({ username: req.user.username }).select("username name");
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }
  return res.json(user);
});

app.get("/api/users", authMiddleware, async (req, res) => {
  const users = await User.find({ username: { $ne: req.user.username } })
    .select("username name")
    .sort({ username: 1 });
  return res.json(users);
});

app.put("/api/settings", authMiddleware, async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    const password = req.body.password || "";

    const user = await User.findOne({ username: req.user.username });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (name) {
      user.name = name;
    }

    if (password) {
      user.password = await bcrypt.hash(password, 10);
    }

    await user.save();

    const token = createToken(user);

    return res.json({
      token,
      user: { username: user.username, name: user.name }
    });
  } catch (error) {
    return res.status(500).json({ error: "Unable to update settings" });
  }
});

app.delete("/api/conversations/:username", authMiddleware, async (req, res) => {
  const other = (req.params.username || "").trim().toLowerCase();
  if (!other) {
    return res.status(400).json({ error: "Target user is required" });
  }

  await Message.deleteMany({
    $or: [
      { from: req.user.username, to: other },
      { from: other, to: req.user.username }
    ]
  });

  return res.json({ ok: true });
});

const onlineUsers = {};

function ensureUserRecord(username, name = "") {
  if (!onlineUsers[username]) {
    onlineUsers[username] = {
      sockets: {},
      username,
      name: name || username
    };
  }
  if (name && !onlineUsers[username].name) {
    onlineUsers[username].name = name;
  }
  return onlineUsers[username];
}

function getSocketIdsForUser(username) {
  if (!onlineUsers[username]) return [];
  return Object.keys(onlineUsers[username].sockets || {});
}

function emitToUser(username, event, payload, exceptSocketId = "") {
  const socketIds = getSocketIdsForUser(username);
  socketIds.forEach((sid) => {
    if (exceptSocketId && sid === exceptSocketId) return;
    io.to(sid).emit(event, payload);
  });
}

function buildPresencePayload() {
  const presence = {};
  Object.values(onlineUsers).forEach((user) => {
    const socketCount = Object.keys(user.sockets || {}).length;
    if (!socketCount) return;
    presence[user.username] = {
      username: user.username,
      name: user.name || user.username,
      online: true
    };
  });
  return presence;
}

io.use(socketAuth);

io.on("connection", (socket) => {
  const username = socket.user.username;
  const name = socket.user.name;

  const userRecord = ensureUserRecord(username, name);
  userRecord.sockets[socket.id] = true;

  io.emit("presence", buildPresencePayload());

  socket.on("loadMessages", async ({ withUser }) => {
    if (!withUser) return;

    const messages = await Message.find({
      $or: [
        { from: username, to: withUser },
        { from: withUser, to: username }
      ]
    }).sort({ timestamp: 1 });

    socket.emit("chatHistory", messages);

    await Message.updateMany(
      { from: withUser, to: username, seen: false },
      { $set: { seen: true } }
    );

    emitToUser(withUser, "messagesSeen", { by: username, withUser });
  });

  socket.on("privateMessage", async (data) => {
    const to = (data.to || "").trim().toLowerCase();
    const type = data.type || "text";
    const text = (data.message || "").trim();
    const mediaUrl = data.mediaUrl || "";

    if (!to || to === username) return;
    if (type === "text" && !text) return;
    if ((type === "image" || type === "video") && !mediaUrl) return;

    const payload = {
      from: username,
      to,
      type,
      message: text,
      mediaUrl,
      seen: false
    };

    const saved = await Message.create(payload);

    emitToUser(to, "privateMessage", saved);
    emitToUser(username, "privateMessage", { ...saved.toObject(), seen: true });
  });

  socket.on("editMessage", async ({ messageId, newText }) => {
    const text = (newText || "").trim();
    if (!messageId || !text) return;

    const message = await Message.findById(messageId);
    if (!message) return;
    if (message.from !== username) return;
    if (message.type !== "text") return;

    message.message = text;
    message.edited = true;
    message.editedAt = new Date();
    await message.save();

    emitToUser(message.to, "messageEdited", message);
    emitToUser(username, "messageEdited", message);
  });

  socket.on("deleteMessage", async ({ messageId }) => {
    if (!messageId) return;

    const message = await Message.findById(messageId);
    if (!message) return;
    if (message.from !== username) return;

    const toUser = message.to;
    await Message.deleteOne({ _id: messageId });

    emitToUser(toUser, "messageDeleted", { messageId });
    emitToUser(username, "messageDeleted", { messageId });
  });

  socket.on("deleteConversation", async ({ withUser }) => {
    if (!withUser) return;

    await Message.deleteMany({
      $or: [
        { from: username, to: withUser },
        { from: withUser, to: username }
      ]
    });

    emitToUser(withUser, "conversationDeleted", { withUser: username });
    emitToUser(username, "conversationDeleted", { withUser });
  });

  socket.on("video-offer", ({ to, offer, callId }) => {
    if (!to || !offer) return;
    emitToUser(to, "video-offer", { from: username, offer, callId: callId || "" });
  });

  socket.on("video-answer", ({ to, answer, callId }) => {
    if (!to || !answer) return;
    emitToUser(to, "video-answer", { from: username, answer, callId: callId || "" });
  });

  socket.on("video-ice", ({ to, candidate, callId }) => {
    if (!to || !candidate) return;
    emitToUser(to, "video-ice", { from: username, candidate, callId: callId || "" });
  });

  socket.on("video-decline", ({ to, callId, reason }) => {
    if (!to) return;
    emitToUser(to, "video-decline", { from: username, callId: callId || "", reason: reason || "" });
  });

  socket.on("video-end", ({ to, callId, reason }) => {
    if (!to) return;
    emitToUser(to, "video-end", { from: username, callId: callId || "", reason: reason || "" });
  });

  socket.on("disconnect", () => {
    if (!onlineUsers[username]) return;
    delete onlineUsers[username].sockets[socket.id];
    if (!Object.keys(onlineUsers[username].sockets).length) {
      delete onlineUsers[username];
    }
    io.emit("presence", buildPresencePayload());
  });
});

const basePort = Number(process.env.PORT) || 3000;

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();

    tester.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        resolve(false);
        return;
      }
      resolve(false);
    });

    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });

    tester.listen(port);
  });
}

async function findAvailablePort(startPort, maxTries = 10) {
  let port = startPort;
  let tries = 0;

  while (tries <= maxTries) {
    // Check ports sequentially to avoid startup crashes when one is busy.
    const available = await isPortAvailable(port);
    if (available) {
      return port;
    }

    console.warn(`Port ${port} is in use. Trying ${port + 1}...`);
    port += 1;
    tries += 1;
  }

  return null;
}

async function startServer() {
  try {
    validateRuntimeConfig();
    await connectToMongo();

    const selectedPort = await findAvailablePort(basePort, 50);
    const portToUse = selectedPort || 0;

    if (selectedPort === null) {
      console.warn("No preferred port available. Using an OS-assigned port.");
    }

    server.listen(portToUse, () => {
      const actualPort = server.address()?.port || portToUse;
      console.log(`Server running at http://localhost:${actualPort}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
