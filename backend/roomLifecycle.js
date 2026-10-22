const sm = require("./sessionManager");

// ─── Config ──────────────────────────────────────────────────────────────────
// How long a private room survives after its host disconnects (refresh, flaky
// network, closed tab) before it is ended automatically.
const HOST_GRACE_MS = Number(process.env.HOST_GRACE_MS) || 45000;

const SYSTEM_PUBLIC_ROOM_SPECS = [
  { roomId: "PUB10M", timeout: 10 },
  { roomId: "PUB20M", timeout: 20 },
];
const systemSpec = (roomId) => SYSTEM_PUBLIC_ROOM_SPECS.find((s) => s.roomId === roomId);

const MSG_EXPIRED   = "This room has expired. All messages and code have been permanently deleted.";
const MSG_HOST_LEFT = "The host left and did not come back, so the room has ended. All messages and code have been permanently deleted.";

let io = null;
const expiryTimers    = new Map(); // roomId -> Timeout
const hostGraceTimers = new Map(); // roomId -> { timer, graceEndsAt }

function init(socketServer) {
  io = socketServer;
}

function clearExpiryTimer(roomId) {
  const t = expiryTimers.get(roomId);
  if (t) clearTimeout(t);
  expiryTimers.delete(roomId);
}

function clearHostGrace(roomId) {
  const g = hostGraceTimers.get(roomId);
  if (g) clearTimeout(g.timer);
  hostGraceTimers.delete(roomId);
}

// ─── Expiry ──────────────────────────────────────────────────────────────────
function scheduleExpiry(roomId, expiresAt) {
  clearExpiryTimer(roomId);
  const delay = Math.max(0, Number(expiresAt) - Date.now());
  expiryTimers.set(roomId, setTimeout(() => {
    expiryTimers.delete(roomId);
    const spec = systemSpec(roomId);
    const task = spec ? ensureSystemPublicRoom(spec) : expireRoom(roomId, MSG_EXPIRED);
    task.catch((err) => console.error(`[Lifecycle] expiry of ${roomId} failed:`, err.message));
  }, delay));
}

/** Deletes every trace of a room and tells everyone in it. */
async function expireRoom(roomId, message = MSG_EXPIRED) {
  clearExpiryTimer(roomId);
  clearHostGrace(roomId);
  await sm.deleteRoom(roomId);
  if (io) {
    io.to(roomId).emit("room_expired", { message });
    io.in(roomId).socketsLeave(roomId);
  }
  console.log(`[Lifecycle] Room ${roomId} deleted.`);
}

// ─── Host presence ───────────────────────────────────────────────────────────
function getHostGrace(roomId) {
  const g = hostGraceTimers.get(roomId);
  return g ? g.graceEndsAt : null;
}

function startHostGrace(roomId) {
  if (hostGraceTimers.has(roomId)) return;
  const graceEndsAt = Date.now() + HOST_GRACE_MS;
  const timer = setTimeout(() => {
    hostGraceTimers.delete(roomId);
    expireRoom(roomId, MSG_HOST_LEFT)
      .catch((err) => console.error(`[Lifecycle] host-grace expiry of ${roomId} failed:`, err.message));
  }, HOST_GRACE_MS);
  hostGraceTimers.set(roomId, { timer, graceEndsAt });
  if (io) io.to(roomId).emit("host_status", { connected: false, graceEndsAt });
}

function cancelHostGrace(roomId) {
  if (!hostGraceTimers.has(roomId)) return;
  clearHostGrace(roomId);
  if (io) io.to(roomId).emit("host_status", { connected: true, graceEndsAt: null });
}

// ─── System public rooms ─────────────────────────────────────────────────────
async function ensureSystemPublicRoom(spec) {
  const existing = await sm.getRoom(spec.roomId);
  const now = Date.now();

  if (existing && existing.status === "active" && Number(existing.expiresAt || 0) > now) {
    scheduleExpiry(spec.roomId, existing.expiresAt);
    return existing;
  }

  // Expired (or its keys already timed out in Redis): notify anyone still
  // connected, wipe leftovers, then start a fresh cycle under the same id.
  await sm.deleteRoom(spec.roomId);
  if (io) {
    io.to(spec.roomId).emit("room_expired", {
      message: "This room has expired. A fresh public room has been started.",
    });
    io.in(spec.roomId).socketsLeave(spec.roomId);
  }

  const room = await sm.createRoom({
    roomId: spec.roomId,
    overwrite: true,
    hostId: null,
    hostName: null,
    roomType: "chat",
    timeout: spec.timeout,
    visibility: "public",
    roomName: null,
  });
  scheduleExpiry(spec.roomId, room.expiresAt);
  return room;
}

async function initializeSystemPublicRooms() {
  for (const spec of SYSTEM_PUBLIC_ROOM_SPECS) {
    await ensureSystemPublicRoom(spec);
  }
}

// ─── Restart recovery ────────────────────────────────────────────────────────
// Timers live in memory, so after a restart they are rebuilt from the Redis
// expiry index. No socket survives a restart, so stale participant lists are
// cleared; hosts get the normal grace period to reconnect.
async function restoreRooms() {
  const rows = await sm.listIndexedRooms();
  let restored = 0;
  for (const { roomId } of rows) {
    const room = await sm.getRoom(roomId);
    if (!room) {
      await sm.deleteRoom(roomId);
      continue;
    }
    await sm.clearParticipants(roomId);
    if (systemSpec(roomId)) continue; // handled by initializeSystemPublicRooms
    scheduleExpiry(roomId, room.expiresAt);
    if (room.hostId) startHostGrace(roomId);
    restored++;
  }
  if (restored) console.log(`[Lifecycle] Restored ${restored} room timer(s) after restart.`);
}

module.exports = {
  HOST_GRACE_MS,
  SYSTEM_PUBLIC_ROOM_SPECS,
  systemSpec,
  init,
  scheduleExpiry,
  expireRoom,
  getHostGrace,
  startHostGrace,
  cancelHostGrace,
  ensureSystemPublicRoom,
  initializeSystemPublicRooms,
  restoreRooms,
};
