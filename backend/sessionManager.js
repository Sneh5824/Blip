const crypto = require("crypto");
const redis = require("./redisClient");

// ─── Key helpers ────────────────────────────────────────────────────────────
const K = {
  room:         (id) => `room:${id}`,
  participants: (id) => `participants:${id}`,   // hash: guestId -> participant JSON
  messages:     (id) => `messages:${id}`,       // list of message JSON
  messageIds:   (id) => `msgids:${id}`,         // set of message ids (for reaction validation)
  reactions:    (id) => `reactions:${id}`,      // hash: messageId -> { emoji: [userId] }
  code:         (id) => `code:${id}`,
  expiryIndex:  "rooms:expiry",                 // zset: roomId scored by expiresAt
};

const roomDataKeys = (id) => [
  K.room(id), K.participants(id), K.messages(id), K.messageIds(id), K.reactions(id), K.code(id),
];

const MAX_MESSAGES = 300;

// Milliseconds until expiresAt (relative PX works on every Redis version).
const ttlMs = (expiresAt) => Math.max(1, Number(expiresAt) - Date.now());

// ─── Public user id ──────────────────────────────────────────────────────────
// guestId is a private credential (it decides who the host is), so it never
// leaves the server. Everything broadcast to clients uses this derived id.
function publicUserId(roomId, guestId) {
  return crypto.createHash("sha256").update(`${roomId}:${guestId}`).digest("hex").slice(0, 16);
}

// ─── Room ID generator (e.g. "A3BZ9K") ───────────────────────────────────────
function generateRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 6; i++) id += chars[crypto.randomInt(chars.length)];
  return id;
}

// ─── Random room name generator ───────────────────────────────────────────────
const ROOM_ADJECTIVES = [
  "Blazing", "Sneaky", "Cosmic", "Cursed", "Chaotic", "Lazy", "Hungry",
  "Sleepy", "Frantic", "Haunted", "Flying", "Broken", "Caffeinated",
  "Jugaadu", "Desi", "Unstoppable", "Legendary", "Notorious", "Salty",
  "Turbocharged", "Delirious", "Midnight", "Yolo", "Panicked", "Silent",
];
const ROOM_NOUNS = [
  "Debuggers", "Stack Overflow", "Merge Conflict", "Git Pushers", "Segfault",
  "Null Pointers", "Memory Leak", "Keyboard Warriors", "Loop Breakers",
  "Syntax Errors", "404 Squad", "Terminal Monkeys", "Runtime Errors",
  "Code Monkeys", "Infinite Loopers", "Deadlock Gang", "Race Condition",
  "Backenders", "Div Wreckers", "CSS Fighters", "Off-by-One Club",
  "Production Breakers", "Import Brigade", "Regex Wizards", "Todo Deleters",
];
function generateRoomName() {
  const adj  = ROOM_ADJECTIVES[Math.floor(Math.random() * ROOM_ADJECTIVES.length)];
  const noun = ROOM_NOUNS[Math.floor(Math.random() * ROOM_NOUNS.length)];
  return `${adj} ${noun}`;
}

// ─── Room CRUD ────────────────────────────────────────────────────────────────
/**
 * Creates a room. Every room key expires in Redis at `expiresAt`, so data is
 * removed even if the process dies before its in-memory timer fires.
 *
 * - roomId given + overwrite=false → returns null if that id is already taken.
 * - roomId given + overwrite=true  → replaces whatever is there (system rooms).
 * - no roomId → a fresh random id that is not in use.
 */
async function createRoom({
  hostId, hostName, roomType, timeout, roomName = null,
  visibility = "private", roomId = null, overwrite = false,
}) {
  const now       = Date.now();
  const expiresAt = now + timeout * 60 * 1000;
  const finalName = (roomName && roomName.trim()) ? roomName.trim() : generateRoomName();

  const build = (id) => ({
    roomId: id,
    hostId,
    hostName,
    roomType,
    timeout,
    visibility,
    roomName: finalName,
    createdAt: now,
    expiresAt,
    status: "active",
    problemLink: null,
    language: "javascript",
  });

  const fixedId = roomId ? String(roomId).trim().toUpperCase() : null;
  const candidates = fixedId ? [fixedId] : Array.from({ length: 10 }, generateRoomId);

  for (const id of candidates) {
    const room = build(id);
    const payload = JSON.stringify(room);
    const ok = (fixedId && overwrite)
      ? await redis.set(K.room(id), payload, { PX: ttlMs(expiresAt) })
      : await redis.set(K.room(id), payload, { PX: ttlMs(expiresAt), NX: true });
    if (ok) {
      await redis.zAdd(K.expiryIndex, { score: expiresAt, value: id });
      return room;
    }
  }
  if (fixedId) return null;
  throw new Error("Could not allocate a unique room id.");
}

async function getRoom(roomId) {
  if (!roomId) return null;
  const data = await redis.get(K.room(roomId));
  return data ? JSON.parse(data) : null;
}

async function updateRoom(roomId, updates) {
  const room = await getRoom(roomId);
  if (!room) return null;
  const updated = { ...room, ...updates };
  await redis.set(K.room(roomId), JSON.stringify(updated), { PX: ttlMs(room.expiresAt) });
  return updated;
}

async function deleteRoom(roomId) {
  await redis.del(roomDataKeys(roomId));
  await redis.zRem(K.expiryIndex, roomId);
}

/** All indexed rooms as [{ roomId, expiresAt }]. */
async function listIndexedRooms() {
  const rows = await redis.zRangeWithScores(K.expiryIndex, 0, -1);
  return rows.map((r) => ({ roomId: r.value, expiresAt: Number(r.score) }));
}

async function removeFromIndex(roomId) {
  await redis.zRem(K.expiryIndex, roomId);
}

/** What clients are allowed to see about a room (no host credential). */
function toClientRoom(room) {
  if (!room) return null;
  return {
    roomId:      room.roomId,
    roomName:    room.roomName || null,
    roomType:    room.roomType,
    visibility:  room.visibility || "private",
    timeout:     room.timeout,
    createdAt:   room.createdAt,
    expiresAt:   room.expiresAt,
    status:      room.status,
    problemLink: room.problemLink || null,
    language:    room.language || "javascript",
    hostUserId:  room.hostId ? publicUserId(room.roomId, room.hostId) : null,
  };
}

// ─── Participants ─────────────────────────────────────────────────────────────
async function upsertParticipant(roomId, expiresAt, guestId, participant) {
  await redis.multi()
    .hSet(K.participants(roomId), guestId, JSON.stringify(participant))
    .pExpireAt(K.participants(roomId), expiresAt)
    .exec();
}

async function removeParticipant(roomId, guestId) {
  await redis.hDel(K.participants(roomId), guestId);
}

async function clearParticipants(roomId) {
  await redis.del(K.participants(roomId));
}

/** Participants as clients see them: [{ userId, displayName, role, joinedAt }]. */
async function getParticipants(roomId) {
  const all = await redis.hGetAll(K.participants(roomId));
  return Object.values(all || {})
    .map((d) => JSON.parse(d))
    .sort((a, b) => a.joinedAt - b.joinedAt);
}

async function isParticipant(roomId, guestId) {
  return Number(await redis.hExists(K.participants(roomId), guestId)) === 1;
}

async function countParticipants(roomId) {
  return Number(await redis.hLen(K.participants(roomId)));
}

// ─── Messages ─────────────────────────────────────────────────────────────────
async function addMessage(roomId, expiresAt, message) {
  await redis.multi()
    .rPush(K.messages(roomId), JSON.stringify(message))
    .lTrim(K.messages(roomId), -MAX_MESSAGES, -1)
    .pExpireAt(K.messages(roomId), expiresAt)
    .sAdd(K.messageIds(roomId), message.id)
    .pExpireAt(K.messageIds(roomId), expiresAt)
    .exec();
}

/** Messages with their current reactions merged in. */
async function getMessages(roomId) {
  const [data, reactions] = await Promise.all([
    redis.lRange(K.messages(roomId), 0, -1),
    redis.hGetAll(K.reactions(roomId)),
  ]);
  return data.map((d) => {
    const msg = JSON.parse(d);
    const r = reactions && reactions[msg.id];
    return r ? { ...msg, reactions: JSON.parse(r) } : msg;
  });
}

async function countMessages(roomId) {
  return Number(await redis.lLen(K.messages(roomId)));
}

// Reactions are read-modify-write; serialise them per room so concurrent
// toggles cannot overwrite each other (single backend process).
const roomLocks = new Map();
function withRoomLock(roomId, fn) {
  const prev = roomLocks.get(roomId) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  roomLocks.set(roomId, tail);
  tail.then(() => { if (roomLocks.get(roomId) === tail) roomLocks.delete(roomId); });
  return run;
}

async function toggleMessageReaction(roomId, expiresAt, messageId, emoji, userId) {
  return withRoomLock(roomId, async () => {
    const exists = Number(await redis.sIsMember(K.messageIds(roomId), messageId)) === 1;
    if (!exists) return null;

    const raw = await redis.hGet(K.reactions(roomId), messageId);
    const reactions = raw ? JSON.parse(raw) : {};
    const users = Array.isArray(reactions[emoji]) ? [...reactions[emoji]] : [];

    const existingIdx = users.indexOf(userId);
    if (existingIdx >= 0) users.splice(existingIdx, 1);
    else users.push(userId);

    if (users.length > 0) reactions[emoji] = users;
    else delete reactions[emoji];

    await redis.multi()
      .hSet(K.reactions(roomId), messageId, JSON.stringify(reactions))
      .pExpireAt(K.reactions(roomId), expiresAt)
      .exec();

    return { messageId, reactions };
  });
}

// ─── Code ─────────────────────────────────────────────────────────────────────
async function getCode(roomId) {
  return (await redis.get(K.code(roomId))) || "";
}

async function setCode(roomId, expiresAt, code) {
  await redis.set(K.code(roomId), code, { PX: ttlMs(expiresAt) });
}

module.exports = {
  K,
  MAX_MESSAGES,
  publicUserId,
  createRoom,
  getRoom,
  updateRoom,
  deleteRoom,
  listIndexedRooms,
  removeFromIndex,
  toClientRoom,
  upsertParticipant,
  removeParticipant,
  clearParticipants,
  getParticipants,
  isParticipant,
  countParticipants,
  addMessage,
  getMessages,
  countMessages,
  toggleMessageReaction,
  getCode,
  setCode,
};
