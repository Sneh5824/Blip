const config = require("./config");
config.reportConfig(); // exits with a clear message on invalid production config

const express = require("express");
const http    = require("http");
const cors    = require("cors");
const crypto  = require("crypto");
const { Server } = require("socket.io");
const redis = require("./redisClient");
const sm = require("./sessionManager");
const lifecycle = require("./roomLifecycle");
const { runCode, RunnerBusyError, SUPPORTED_LANGUAGES } = require("./codeRunner");
const { limitByIp } = require("./rateLimit");

const app = express();

// Render (and most hosts) sit behind a proxy: use X-Forwarded-For for req.ip,
// otherwise every visitor shares the proxy's IP in the rate limiters.
app.set("trust proxy", config.TRUST_PROXY);
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  next();
});
app.use(cors({ origin: config.CORS_ORIGINS }));
app.use(express.json({ limit: "256kb" }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: config.CORS_ORIGINS, methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
  // Attachments travel as base64 data URLs: 3MB file ≈ 4MB base64 + envelope.
  maxHttpBufferSize: 5 * 1024 * 1024,
});

lifecycle.init(io);

const VALID_TYPES    = ["chat", "coding"];
const VALID_TIMEOUTS = [10, 20, 30, 60];
const ROOM_ID_RE     = /^[A-Z0-9]{4,8}$/;
const UUID_RE        = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE_EXECUTION_ENABLED = config.CODE_EXECUTION;

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
app.post("/api/rooms", limitByIp({ windowMs: 60000, max: config.ROOM_CREATE_LIMIT_PER_MIN }), async (req, res) => {
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
    const rooms = await Promise.all((await sm.listPublicRooms()).map(publicRoomSummary));
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
      const expected = config.ADMIN_PASSWORD;
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
    const rooms = await Promise.all((await sm.listPublicRooms()).map(async (room) => ({
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

// ─── Attachments ─────────────────────────────────────────────────────────────
// Ids are random UUIDs only shared inside the room. Only non-SVG images and
// audio are served inline; everything else is a forced download.
function contentDisposition(type, fileName) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

app.get("/api/rooms/:roomId/attachments/:attId", limitByIp({ windowMs: 60000, max: 300 }), async (req, res) => {
  try {
    const roomId = req.params.roomId.toUpperCase();
    const attId = req.params.attId.toLowerCase();
    if (!ROOM_ID_RE.test(roomId) || !UUID_RE.test(attId)) return res.status(404).json({ error: "Not found." });

    const att = await sm.getAttachment(roomId, attId);
    if (!att) return res.status(404).json({ error: "Attachment not found or room expired." });

    const inline = (att.mimeType.startsWith("image/") && att.mimeType !== "image/svg+xml") || att.mimeType.startsWith("audio/");
    res.set({
      "Content-Type": inline ? att.mimeType : "application/octet-stream",
      "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", att.fileName || "file"),
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Cache-Control": "private, max-age=3600, immutable",
    });
    res.send(Buffer.from(att.base64, "base64"));
  } catch (err) {
    console.error("[API] GET attachment error:", err.message);
    res.status(500).json({ error: "Internal server error." });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
// Liveness only (always 200 so the host does not restart us during a Redis
// blip); `redis` reports the connection state without spending a command.
const startedAt = Date.now();
app.get("/health", (_req, res) => res.json({
  status: "ok",
  redis: redis.isReady ? "ready" : "connecting",
  uptimeSec: Math.round((Date.now() - startedAt) / 1000),
  ts: Date.now(),
}));

// ─── Socket.IO ────────────────────────────────────────────────────────────────
require("./socket")(io, { codeExecution: CODE_EXECUTION_ENABLED });

// ─── Start ────────────────────────────────────────────────────────────────────
// Log listen errors and exit so the host / nodemon restarts cleanly
server.on("error", (err) => {
  console.error("[Server] listen error:", err.message);
  process.exit(1);
});

async function initializeRooms(attempt = 1) {
  try {
    await lifecycle.restoreRooms();
    await lifecycle.initializeSystemPublicRooms();
  } catch (err) {
    console.error(`[Server] Failed to initialize rooms (attempt ${attempt}):`, err.message);
    if (attempt < 5) setTimeout(() => initializeRooms(attempt + 1), 5000 * attempt).unref();
  }
}

const onListening = async () => {
  console.log(`[Server] Blip backend listening on ${config.HOST || "all interfaces"}:${config.PORT}`);
  await redis.whenConnected;
  await initializeRooms();
  console.log(`[Server] Blip backend running on http://localhost:${config.PORT}`);
};
if (config.HOST) server.listen(config.PORT, config.HOST, onListening);
else server.listen(config.PORT, onListening);

// ─── Graceful shutdown ───────────────────────────────────────────────────────
// Hosts send SIGTERM on deploys, restarts and free-tier spin-down. Persist
// buffered editor content, close sockets (clients auto-reconnect), then exit.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Server] ${signal} received, shutting down...`);
  const force = setTimeout(() => process.exit(0), 10000);
  force.unref();
  try {
    await sm.flushPendingCode();
    await new Promise((resolve) => io.close(() => resolve()));
    await redis.quit().catch(() => {});
  } catch (err) {
    console.error("[Server] shutdown error:", err.message);
  }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// A bug in one handler should be logged, not silently kill every room.
process.on("unhandledRejection", (err) => {
  console.error("[Server] Unhandled rejection:", err && err.message ? err.message : err);
});
