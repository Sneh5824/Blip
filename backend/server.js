require("dotenv").config();
const express = require("express");
const http    = require("http");
const cors    = require("cors");
const crypto  = require("crypto");
const { Server } = require("socket.io");
const sm = require("./sessionManager");
const lifecycle = require("./roomLifecycle");
const { runCode, RunnerBusyError, SUPPORTED_LANGUAGES } = require("./codeRunner");
const { limitByIp } = require("./rateLimit");

const app = express();

app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.json({ limit: "256kb" }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL || "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
  // Attachments travel as base64 data URLs: 3MB file ≈ 4MB base64 + envelope.
  maxHttpBufferSize: 5 * 1024 * 1024,
});

lifecycle.init(io);

const VALID_TYPES    = ["chat", "coding"];
const VALID_TIMEOUTS = [10, 20, 30, 60];
const ROOM_ID_RE     = /^[A-Z0-9]{4,8}$/;
const CODE_EXECUTION_ENABLED = !["off", "false", "0", "disabled"].includes(String(process.env.CODE_EXECUTION || "").toLowerCase());

// ─── Admin sessions (token -> expiresAt, in memory) ─────────────────────────
const adminSessions = new Map();
const ADMIN_SESSION_TTL_MS = 1000 * 60 * 60; // 1 hour

function createAdminSession() {
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  adminSessions.set(token, expiresAt);
  return { token, expiresAt };
}

function validateAdminToken(token) {
  if (!token) return false;
  const exp = adminSessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [token, exp] of adminSessions) if (exp <= now) adminSessions.delete(token);
}, 10 * 60 * 1000).unref();

/** Constant-time password comparison (hashing first equalises lengths). */
function passwordMatches(given, expected) {
  const a = crypto.createHash("sha256").update(String(given)).digest();
  const b = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  const h = req.get("authorization") || "";
  const parts = h.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") return res.status(401).json({ error: "Unauthorized" });
  if (!validateAdminToken(parts[1])) return res.status(401).json({ error: "Invalid or expired admin token" });
  next();
}

/** Active rooms from the expiry index, optionally filtered. */
async function listActiveRooms(filter = () => true) {
  const now = Date.now();
  const rooms = [];
  for (const { roomId } of await sm.listIndexedRooms()) {
    const room = await sm.getRoom(roomId);
    if (!room || room.status !== "active" || Number(room.expiresAt || 0) <= now) continue;
    if (filter(room)) rooms.push(room);
  }
  return rooms;
}

async function publicRoomSummary(room) {
  return {
    roomId: room.roomId,
    roomName: room.roomName || null,
    roomType: room.roomType,
    visibility: "public",
    timeout: room.timeout,
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
    participantCount: await sm.countParticipants(room.roomId),
  };
}

const isPublic = (room) => (room.visibility || "private") === "public";

// ─── REST API ────────────────────────────────────────────────────────────────

// POST /api/rooms  — create a new private room
app.post("/api/rooms", limitByIp({ windowMs: 60000, max: Number(process.env.ROOM_CREATE_LIMIT_PER_MIN) || 20 }), async (req, res) => {
  try {
    const { guestId, displayName, roomType, timeout, roomName, visibility = "private" } = req.body || {};
    if (typeof guestId !== "string" || guestId.length < 8 || guestId.length > 100 || !displayName || !roomType || !timeout) {
      return res.status(400).json({ error: "Missing required fields." });
    }
    if (roomName != null && typeof roomName !== "string") return res.status(400).json({ error: "Invalid room name." });
    if (roomName && roomName.trim().length > 40) {
      return res.status(400).json({ error: "Room name too long (max 40 characters)." });
    }
    if (!VALID_TYPES.includes(roomType))    return res.status(400).json({ error: "Invalid roomType." });
    if (!VALID_TIMEOUTS.includes(timeout))  return res.status(400).json({ error: "Invalid timeout." });
    if (visibility !== "private") return res.status(400).json({ error: "Public rooms are system-managed only." });

    const room = await sm.createRoom({
      hostId: guestId,
      hostName: String(displayName).slice(0, 40),
      roomType,
      timeout,
      visibility,
      roomName: (roomName && roomName.trim()) || null,
    });
    lifecycle.scheduleExpiry(room.roomId, room.expiresAt);

    console.log(`[API] Room ${room.roomId} created (${roomType}, ${timeout}m)`);
    res.status(201).json(sm.toClientRoom(room));
  } catch (err) {
    console.error("[API] POST /api/rooms error:", err.message);
    res.status(500).json({ error: "Internal server error." });
  }
});

// GET /api/rooms/:roomId  — check room existence / get metadata
app.get("/api/rooms/:roomId", async (req, res) => {
  try {
    const id = req.params.roomId.toUpperCase();
    if (!ROOM_ID_RE.test(id)) return res.status(404).json({ error: "Room not found or has expired." });
    const room = await sm.getRoom(id);
    if (!room || room.status !== "active") return res.status(404).json({ error: "Room not found or has expired." });
    res.json(sm.toClientRoom(room));
  } catch (err) {
    console.error("[API] GET /api/rooms/:roomId error:", err.message);
    res.status(500).json({ error: "Internal server error." });
  }
});

// GET /api/public-rooms  — list active public rooms (system + admin-created)
app.get("/api/public-rooms", async (_req, res) => {
  try {
    const rooms = await Promise.all((await listActiveRooms(isPublic)).map(publicRoomSummary));
    rooms.sort((a, b) => a.expiresAt - b.expiresAt);
    res.json({ rooms });
  } catch (err) {
    console.error("[API] GET /api/public-rooms error:", err.message);
    res.status(500).json({ error: "Internal server error." });
  }
});

// ─── Admin API ─────────────────────────────────────────────────────────────
// POST /api/admin/login  — exchange password for admin token (set ADMIN_PASSWORD in env)
app.post("/api/admin/login",
  limitByIp({ windowMs: 15 * 60 * 1000, max: 10 }, "Too many login attempts. Try again in 15 minutes."),
  async (req, res) => {
    try {
      const { password } = req.body || {};
      const expected = process.env.ADMIN_PASSWORD;
      if (!expected) return res.status(500).json({ error: "Admin login not configured on server." });
      if (typeof password !== "string" || !passwordMatches(password, expected)) {
        return res.status(401).json({ error: "Invalid credentials." });
      }
      res.json(createAdminSession());
    } catch (err) {
      console.error("[API] POST /api/admin/login error:", err.message);
      res.status(500).json({ error: "Internal server error." });
    }
  });

// GET /api/admin/stats  — basic site statistics
app.get("/api/admin/stats", requireAdmin, async (_req, res) => {
  try {
    const rooms = await listActiveRooms();
    let totalParticipants = 0, totalMessages = 0;
    for (const room of rooms) {
      totalParticipants += await sm.countParticipants(room.roomId);
      totalMessages     += await sm.countMessages(room.roomId);
    }
    res.json({
      activeRooms: rooms.length,
      publicRooms: rooms.filter(isPublic).length,
      totalParticipants,
      totalMessages,
    });
  } catch (err) {
    console.error("[API] GET /api/admin/stats error:", err.message);
    res.status(500).json({ error: "Internal server error." });
  }
});

// Admin: list all public rooms (including admin-created ones)
app.get("/api/admin/public-rooms", requireAdmin, async (_req, res) => {
  try {
    const rooms = await Promise.all((await listActiveRooms(isPublic)).map(async (room) => ({
      ...(await publicRoomSummary(room)),
      system: Boolean(lifecycle.systemSpec(room.roomId)),
    })));
    res.json({ rooms });
  } catch (err) {
    console.error("[API] GET /api/admin/public-rooms error:", err.message);
    res.status(500).json({ error: "Internal server error." });
  }
});

// Admin: create a public room
app.post("/api/admin/public-rooms", requireAdmin, async (req, res) => {
  try {
    const { timeout = 10, roomName = null, roomId = null, roomType = "chat" } = req.body || {};
    if (!VALID_TIMEOUTS.includes(Number(timeout))) return res.status(400).json({ error: "Invalid timeout." });
    if (!VALID_TYPES.includes(roomType)) return res.status(400).json({ error: "Invalid roomType." });
    if (roomName != null && (typeof roomName !== "string" || roomName.trim().length > 40)) {
      return res.status(400).json({ error: "Room name must be at most 40 characters." });
    }
    let fixedId = null;
    if (roomId != null && roomId !== "") {
      fixedId = String(roomId).trim().toUpperCase();
      if (!ROOM_ID_RE.test(fixedId)) return res.status(400).json({ error: "Room ID must be 4-8 letters/digits." });
    }

    const room = await sm.createRoom({
      hostId: null,
      hostName: null,
      roomType,
      timeout: Number(timeout),
      visibility: "public",
      roomName: (roomName && roomName.trim()) || null,
      roomId: fixedId,
      overwrite: false,
    });
    if (!room) return res.status(409).json({ error: `Room ID ${fixedId} is already in use.` });

    lifecycle.scheduleExpiry(room.roomId, room.expiresAt);
    res.status(201).json(sm.toClientRoom(room));
  } catch (err) {
    console.error("[API] POST /api/admin/public-rooms error:", err.message);
    res.status(500).json({ error: "Internal server error." });
  }
});

// Admin: delete a public room (system rooms restart with a fresh cycle)
app.delete("/api/admin/public-rooms/:roomId", requireAdmin, async (req, res) => {
  try {
    const id = req.params.roomId.toUpperCase();
    const room = await sm.getRoom(id);
    if (!room) return res.status(404).json({ error: "Room not found." });
    if (!isPublic(room)) return res.status(400).json({ error: "Not a public room." });

    await lifecycle.expireRoom(id, "This public room has been removed by an admin.");
    const spec = lifecycle.systemSpec(id);
    if (spec) await lifecycle.ensureSystemPublicRoom(spec);
    res.json({ ok: true, recreated: Boolean(spec) });
  } catch (err) {
    console.error("[API] DELETE /api/admin/public-rooms/:roomId error:", err.message);
    res.status(500).json({ error: "Internal server error." });
  }
});

// ─── Code execution ──────────────────────────────────────────────────────────
// Only participants of an active coding room may run code.
app.post("/api/run", limitByIp({ windowMs: 60000, max: 20 }, "Too many runs. Wait a minute."), async (req, res) => {
  if (!CODE_EXECUTION_ENABLED) return res.status(503).json({ error: "Code execution is disabled on this server." });
  const { roomId, guestId, language, code, stdin = "" } = req.body || {};
  if (typeof language !== "string" || typeof code !== "string" || !code) {
    return res.status(400).json({ error: "Missing language or code." });
  }
  if (!SUPPORTED_LANGUAGES.includes(language)) return res.status(400).json({ error: `Language "${language}" is not supported.` });
  if (code.length > 100 * 1024) return res.status(400).json({ error: "Code too large (max 100KB)." });
  if (typeof stdin !== "string" || stdin.length > 64 * 1024) return res.status(400).json({ error: "Input too large (max 64KB)." });

  try {
    const id = typeof roomId === "string" ? roomId.toUpperCase() : "";
    const room = ROOM_ID_RE.test(id) ? await sm.getRoom(id) : null;
    if (!room || room.status !== "active" || room.roomType !== "coding") {
      return res.status(403).json({ error: "Code can only be run from an active coding room." });
    }
    if (typeof guestId !== "string" || !(await sm.isParticipant(id, guestId))) {
      return res.status(403).json({ error: "Join the room before running code." });
    }

    const start  = Date.now();
    const result = await runCode(language, code, stdin);
    result.time  = `${Date.now() - start}ms`;
    res.json({ run: result });
  } catch (err) {
    if (err instanceof RunnerBusyError) return res.status(503).json({ error: err.message });
    console.error("[API] /api/run error:", err.message);
    res.status(500).json({ error: "Code execution failed." });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok", ts: Date.now() }));

// ─── Socket.IO ────────────────────────────────────────────────────────────────
require("./socket")(io);

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5001;
// Log listen errors and exit gracefully so nodemon can restart cleanly
server.on("error", (err) => {
  console.error("[Server] listen error", err);
  process.exit(1);
});

server.listen(PORT, async () => {
  try {
    await lifecycle.restoreRooms();
    await lifecycle.initializeSystemPublicRooms();
  } catch (err) {
    console.error("[Server] Failed to initialize rooms:", err.message);
  }
  console.log(`[Server] Blip backend running on http://localhost:${PORT}`);
});
