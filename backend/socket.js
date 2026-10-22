const { randomUUID: uuidv4 } = require("crypto");
const sm = require("./sessionManager");
const lifecycle = require("./roomLifecycle");
const { createLimiter } = require("./rateLimit");

// ─── Limits / validation ─────────────────────────────────────────────────────
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
const MAX_TEXT_LENGTH      = 4000;
const MAX_CODE_LENGTH      = 200 * 1024;
const MAX_NAME_LENGTH      = 40;
const ALLOWED_REACTIONS    = ["👍", "🔥", "😂", "👏", "💡"];
const EDITOR_LANGUAGES     = ["javascript", "python", "java", "cpp", "typescript", "go", "rust"];

const messageLimiter    = createLimiter({ windowMs: 10000, max: 15 });
const attachmentLimiter = createLimiter({ windowMs: 60000, max: 6 });
const reactionLimiter   = createLimiter({ windowMs: 10000, max: 30 });

// Some recorders label audio-only output with a video/generic type.
const AUDIO_CONTAINER_MIMES = ["video/webm", "video/mp4", "video/ogg", "application/octet-stream"];

const DATA_URL_RE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)((?:;[a-z0-9.+-]+=[a-z0-9.+-]+)*);base64,([a-z0-9+/]*={0,2})$/i;

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

function cleanDisplayName(name) {
  // eslint-disable-next-line no-control-regex
  const n = str(name, 200).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME_LENGTH);
  return n || "Anonymous";
}

/** Only absolute http(s) URLs are accepted (blocks javascript:, data:, etc.). */
function safeHttpUrl(raw) {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Validates a client attachment; returns { attachment } or { error }. */
function validateAttachment(att) {
  if (!att || typeof att !== "object" || typeof att.dataUrl !== "string") {
    return { error: "Invalid attachment." };
  }
  // base64 needs 4 chars per 3 bytes; reject obviously oversized payloads before regex work.
  if (att.dataUrl.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 200) {
    return { error: "Attachment too large. Keep files under 3MB." };
  }
  const m = DATA_URL_RE.exec(att.dataUrl);
  if (!m) return { error: "Invalid attachment data." };

  const mimeType = m[1].toLowerCase();
  const b64 = m[3];
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  const size = Math.floor((b64.length * 3) / 4) - padding;
  if (size <= 0) return { error: "Attachment is empty." };
  if (size > MAX_ATTACHMENT_BYTES) return { error: "Attachment too large. Keep files under 3MB." };

  // eslint-disable-next-line no-control-regex
  const fileName = (str(att.fileName, 300).split(/[\\/]/).pop() || "")
    .replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120) || "file";

  const looksAudio = /\.(webm|ogg|wav|mp3|m4a|aac|flac)$/i.test(fileName);
  const kind = mimeType.startsWith("image/") && mimeType !== "image/svg+xml"
    ? "image"
    : (mimeType.startsWith("audio/") || (looksAudio && AUDIO_CONTAINER_MIMES.includes(mimeType)))
      ? "audio"
      : "file";

  const attachment = { base64: b64, fileName, mimeType, size, kind };
  const duration = Number(att.durationSec);
  if (kind === "audio" && Number.isFinite(duration) && duration > 0) {
    attachment.durationSec = Math.min(3600, Math.floor(duration));
  }
  return { attachment };
}

function cleanReplyTo(replyTo) {
  if (!replyTo || typeof replyTo !== "object" || typeof replyTo.id !== "string") return null;
  const type = ["text", "attachment", "problem_link"].includes(replyTo.type) ? replyTo.type : "text";
  return {
    id: str(replyTo.id, 64),
    senderName: cleanDisplayName(replyTo.senderName),
    content: str(replyTo.content, 200),
    type,
  };
}

function cleanPosition(p) {
  if (!p || typeof p !== "object") return null;
  const n = (v) => { const x = Math.floor(Number(v)); return Number.isFinite(x) && x >= 1 ? Math.min(x, 1e6) : 1; };
  return { lineNumber: n(p.lineNumber), column: n(p.column) };
}

function cleanSelection(s) {
  if (!s || typeof s !== "object") return null;
  const a = cleanPosition({ lineNumber: s.startLineNumber, column: s.startColumn });
  const b = cleanPosition({ lineNumber: s.endLineNumber, column: s.endColumn });
  return { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column };
}

// ─── Socket module ────────────────────────────────────────────────────────────
module.exports = (io, { codeExecution = false } = {}) => {
  /** Non-fatal problem with an action (the client stays in the room). */
  const actionError = (socket, message) => socket.emit("action_error", { message });

  /**
   * The room this socket has joined, from the copy cached at join time (no
   * Redis read). Expiry removes sockets from the Socket.IO room, so membership
   * of that room is the source of truth for "still active".
   */
  function joinedRoom(socket) {
    const { roomId, room } = socket.data;
    if (!roomId || !room || !socket.rooms.has(roomId)) return null;
    if (room.expiresAt <= Date.now()) return null;
    return room;
  }

  /** Removes the socket from its room; only drops the participant if no other tab of theirs remains. */
  async function leaveCurrentRoom(socket) {
    const { roomId, guestId, userId, displayName, isHost } = socket.data;
    if (!roomId) return;
    socket.data.roomId = null;
    socket.leave(roomId);

    const sockets = await io.in(roomId).fetchSockets();
    if (sockets.some((s) => s.id !== socket.id && s.data.guestId === guestId)) return;

    socket.to(roomId).emit("typing_update", { userId, displayName, isTyping: false });
    socket.to(roomId).emit("cursor_removed", { userId });

    const room = await sm.getRoom(roomId);
    if (!room) return;

    await sm.removeParticipant(roomId, guestId);
    io.to(roomId).emit("user_left", { userId, displayName });
    io.to(roomId).emit("participants_update", await sm.getParticipants(roomId));

    if (isHost) lifecycle.startHostGrace(roomId);
    console.log(`[Socket] ${displayName} left room ${roomId}`);
  }

  io.on("connection", (socket) => {
    socket.data = {};

    // ── join_room ────────────────────────────────────────────────────────────
    socket.on("join_room", async (payload = {}) => {
      try {
        const roomId  = str(payload.roomId, 16).trim().toUpperCase();
        const guestId = str(payload.guestId, 100).trim();
        if (!roomId || guestId.length < 8) {
          socket.emit("room_error", { message: "Invalid room or identity." });
          return;
        }
        const displayName = cleanDisplayName(payload.displayName);

        // Switching rooms (or identities) on the same socket: leave cleanly first.
        if (socket.data.roomId && (socket.data.roomId !== roomId || socket.data.guestId !== guestId)) {
          await leaveCurrentRoom(socket);
        }

        const room = await sm.getRoom(roomId);
        if (!room) {
          socket.emit("room_error", { message: "Room not found or has already expired." });
          return;
        }
        if (room.status !== "active" || room.expiresAt <= Date.now()) {
          socket.emit("room_error", { message: "This room has expired." });
          return;
        }

        const isHost = Boolean(room.hostId) && room.hostId === guestId;
        const role   = isHost ? "host" : "member";
        const userId = sm.publicUserId(roomId, guestId);

        const alreadyPresent = await sm.isParticipant(roomId, guestId);
        await sm.upsertParticipant(roomId, room.expiresAt, guestId, {
          userId, displayName, role, joinedAt: Date.now(),
        });

        socket.join(roomId);
        socket.data = {
          roomId, guestId, userId, displayName, isHost,
          room: { roomId, expiresAt: room.expiresAt, roomType: room.roomType, hostId: Boolean(room.hostId) },
        };

        if (isHost) lifecycle.cancelHostGrace(roomId);

        const [participants, messages, code] = await Promise.all([
          sm.getParticipants(roomId),
          sm.getMessages(roomId),
          sm.getCode(roomId),
        ]);
        const graceEndsAt = lifecycle.getHostGrace(roomId);

        socket.emit("room_joined", {
          room: sm.toClientRoom(room),
          participants,
          messages,
          code,
          isHost,
          selfUserId: userId,
          features: { codeExecution },
          hostStatus: { connected: !graceEndsAt, graceEndsAt },
        });
        if (!alreadyPresent) socket.to(roomId).emit("user_joined", { userId, displayName, role });
        io.to(roomId).emit("participants_update", participants);

        console.log(`[Socket] ${displayName} (${role}) joined room ${roomId}`);
      } catch (err) {
        console.error("[Socket] join_room error:", err.message);
        socket.emit("room_error", { message: "Failed to join room." });
      }
    });

    // ── leave_room ───────────────────────────────────────────────────────────
    socket.on("leave_room", async () => {
      try {
        await leaveCurrentRoom(socket);
      } catch (err) {
        console.error("[Socket] leave_room error:", err.message);
      }
    });

    // ── send_message ─────────────────────────────────────────────────────────
    socket.on("send_message", async (payload = {}) => {
      try {
        const room = joinedRoom(socket);
        if (!room) return;
        const { roomId, guestId, userId, displayName } = socket.data;

        const type = payload.type === "attachment" ? "attachment" : "text";
        const content = str(payload.content, MAX_TEXT_LENGTH + 1).trim();
        if (content.length > MAX_TEXT_LENGTH) {
          actionError(socket, `Message too long (max ${MAX_TEXT_LENGTH} characters).`);
          return;
        }
        if (type === "text" && !content) return;

        if (!messageLimiter(`${roomId}:${guestId}`)) {
          actionError(socket, "You're sending messages too quickly. Slow down a little.");
          return;
        }

        let attachment = null;
        if (type === "attachment") {
          if (!attachmentLimiter(`${roomId}:${guestId}`)) {
            actionError(socket, "Too many attachments. Wait a minute before sending more.");
            return;
          }
          const result = validateAttachment(payload.attachment);
          if (result.error) {
            actionError(socket, result.error);
            return;
          }
          const { base64, ...meta } = result.attachment;
          const attId = uuidv4();
          const stored = await sm.storeAttachment(roomId, room.expiresAt, attId, { ...meta, base64 });
          if (!stored) {
            actionError(socket, "This room's attachment storage is full. Send a link instead.");
            return;
          }
          attachment = { id: attId, ...meta };
        }

        const msg = {
          id:          uuidv4(),
          roomId,
          senderId:    userId,
          senderName:  displayName,
          content,
          timestamp:   Date.now(),
          type,
          attachment,
          replyTo:     cleanReplyTo(payload.replyTo),
          reactions:   {},
        };

        await sm.addMessage(roomId, room.expiresAt, msg);
        io.to(roomId).emit("receive_message", msg);
      } catch (err) {
        console.error("[Socket] send_message error:", err.message);
        actionError(socket, "Message could not be sent.");
      }
    });

    // ── typing_status ───────────────────────────────────────────────────────
    socket.on("typing_status", (payload = {}) => {
      const { roomId, userId, displayName } = socket.data;
      if (!roomId) return;
      socket.to(roomId).emit("typing_update", { userId, displayName, isTyping: !!payload.isTyping });
    });

    // ── toggle_reaction ─────────────────────────────────────────────────────
    socket.on("toggle_reaction", async (payload = {}) => {
      try {
        const room = joinedRoom(socket);
        if (!room) return;
        const { roomId, guestId, userId } = socket.data;
        const messageId = str(payload.messageId, 64);
        if (!messageId || !ALLOWED_REACTIONS.includes(payload.emoji)) return;
        if (!reactionLimiter(`${roomId}:${guestId}`)) return;

        const updated = await sm.toggleMessageReaction(roomId, room.expiresAt, messageId, payload.emoji, userId);
        if (updated) io.to(roomId).emit("reaction_updated", updated);
      } catch (err) {
        console.error("[Socket] toggle_reaction error:", err.message);
      }
    });

    // ── code_update ──────────────────────────────────────────────────────────
    socket.on("code_update", async (payload = {}) => {
      try {
        if (typeof payload.code !== "string") return;
        if (payload.code.length > MAX_CODE_LENGTH) {
          actionError(socket, "Code is too large to sync (max 200KB).");
          return;
        }
        const room = joinedRoom(socket);
        if (!room || room.roomType !== "coding") return;

        sm.setCode(room.roomId, room.expiresAt, payload.code);
        socket.to(room.roomId).emit("code_updated", { code: payload.code });
      } catch (err) {
        console.error("[Socket] code_update error:", err.message);
      }
    });

    // ── language_update ─────────────────────────────────────────────────────
    socket.on("language_update", async (payload = {}) => {
      try {
        if (!EDITOR_LANGUAGES.includes(payload.language)) return;
        const room = joinedRoom(socket);
        if (!room || room.roomType !== "coding") return;

        await sm.updateRoom(room.roomId, { language: payload.language });
        socket.to(room.roomId).emit("language_updated", {
          language: payload.language,
          changedBy: socket.data.displayName,
        });
      } catch (err) {
        console.error("[Socket] language_update error:", err.message);
      }
    });

    // ── cursor_update ───────────────────────────────────────────────────────
    socket.on("cursor_update", (payload = {}) => {
      const { roomId, userId, displayName } = socket.data;
      if (!roomId) return;
      socket.to(roomId).emit("cursor_updated", {
        userId,
        displayName,
        position:  cleanPosition(payload.position),
        selection: cleanSelection(payload.selection),
      });
    });

    // ── share_problem ────────────────────────────────────────────────────────
    socket.on("share_problem", async (payload = {}) => {
      try {
        const room = joinedRoom(socket);
        if (!room) return;
        const { roomId, userId, displayName, isHost } = socket.data;

        // Private rooms: host only. Hostless (public) rooms: anyone.
        if (room.hostId && !isHost) {
          actionError(socket, "Only the host can share a problem link.");
          return;
        }
        const link = safeHttpUrl(payload.link);
        if (!link) {
          actionError(socket, "Problem link must be a valid http(s) URL.");
          return;
        }

        await sm.updateRoom(roomId, { problemLink: link });
        const msg = {
          id:         uuidv4(),
          roomId,
          senderId:   userId,
          senderName: displayName,
          content:    link,
          timestamp:  Date.now(),
          type:       "problem_link",
          reactions:  {},
        };
        await sm.addMessage(roomId, room.expiresAt, msg);
        io.to(roomId).emit("receive_message", msg);
        io.to(roomId).emit("problem_shared", { link, sharedBy: displayName });
      } catch (err) {
        console.error("[Socket] share_problem error:", err.message);
      }
    });

    // ── end_room (host only) ──────────────────────────────────────────────────
    socket.on("end_room", async () => {
      try {
        const room = joinedRoom(socket);
        if (!room) return;
        if (!room.hostId || !socket.data.isHost) {
          actionError(socket, "Only the host can end the room.");
          return;
        }
        await lifecycle.expireRoom(room.roomId, "The host ended this room. All messages and code have been permanently deleted.");
      } catch (err) {
        console.error("[Socket] end_room error:", err.message);
      }
    });

    // ── disconnect ────────────────────────────────────────────────────────────
    socket.on("disconnect", async () => {
      try {
        await leaveCurrentRoom(socket);
      } catch (err) {
        console.error("[Socket] disconnect error:", err.message);
      }
    });
  });
};

module.exports.validateAttachment = validateAttachment;
module.exports.safeHttpUrl = safeHttpUrl;
