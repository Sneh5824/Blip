import { useState, useEffect, useRef, useCallback } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import dynamic from "next/dynamic";
import Timer from "../../components/Timer";
import ParticipantList from "../../components/ParticipantList";
import ChatPanel from "../../components/ChatPanel";
import SnapExpired from "../../components/SnapExpired";
import { getOrCreateIdentity } from "../../lib/identity";
import { getSocket, destroySocket } from "../../lib/socket";
import { safeHttpUrl } from "../../lib/url";

const CodeEditor = dynamic(() => import("../../components/CodeEditor"), { ssr: false });

const STATUS = { LOADING: "loading", ACTIVE: "active", EXPIRED: "expired", ERROR: "error" };

let sysMsgCounter = 0;
const systemMessage = (content) => ({
  id: `sys-${Date.now()}-${++sysMsgCounter}`,
  type: "system",
  content,
  timestamp: Date.now(),
});

// ── Countdown shown while the host is disconnected ──────────────────────────
function HostAwayBanner({ graceEndsAt }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secs = Math.max(0, Math.ceil((graceEndsAt - now) / 1000));
  return (
    <div className="flex-none px-4 py-1.5 text-xs text-center" style={{ background: "rgba(245,158,11,0.12)", borderBottom: "1px solid rgba(245,158,11,0.25)", color: "#fcd34d" }}>
      The host disconnected. The room ends in {secs}s unless they come back.
    </div>
  );
}

// ── Drag-resize hook ────────────────────────────────────────────────────────
function useResize(initialPx, min, max) {
  const [size, setSize] = useState(initialPx);
  const dragging = useRef(false);
  const startX   = useRef(0);
  const startSz  = useRef(0);

  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;
    startX.current   = e.clientX;
    startSz.current  = size;
    document.body.classList.add("resizing");

    const onMove = (ev) => {
      if (!dragging.current) return;
      const delta = ev.clientX - startX.current;
      setSize(Math.max(min, Math.min(max, startSz.current + delta)));
    };
    const onUp = () => {
      dragging.current = false;
      document.body.classList.remove("resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup",   onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
  }, [size, min, max]);

  return [size, onMouseDown];
}

// ── Resize divider ──────────────────────────────────────────────────────────
function ResizeDivider({ onMouseDown }) {
  return (
    <div
      onMouseDown={onMouseDown}
      className="flex-none w-1 cursor-col-resize transition-colors relative group select-none"
      style={{ background: "rgba(255,255,255,0.05)" }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(220,38,38,0.35)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.05)"; }}
      title="Drag to resize"
    >
      {/* Wider invisible hit area */}
      <div className="absolute inset-y-0 -left-1.5 -right-1.5 z-10" onMouseDown={onMouseDown} />
      {/* Dots indicator */}
      <div className="absolute inset-y-0 left-0 right-0 flex flex-col items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        <span className="w-0.5 h-0.5 rounded-full bg-red-400" />
        <span className="w-0.5 h-0.5 rounded-full bg-red-400" />
        <span className="w-0.5 h-0.5 rounded-full bg-red-400" />
      </div>
    </div>
  );
}


export default function RoomPage() {
  const router  = useRouter();
  const { roomId } = router.query;

  // Core state
  const [status,       setStatus]       = useState(STATUS.LOADING);
  const [errorMsg,     setErrorMsg]     = useState("");
  const [room,         setRoom]         = useState(null);
  const [messages,     setMessages]     = useState([]);
  const [participants, setParticipants] = useState([]);
  const [typingUsers,  setTypingUsers]  = useState([]);
  const [remoteCursors, setRemoteCursors] = useState({});
  const [code,         setCode]         = useState("");
  const [isHost,       setIsHost]       = useState(false);
  const [identity,     setIdentity]     = useState(null);
  const [selfUserId,   setSelfUserId]   = useState(null);
  const [language,     setLanguage]     = useState("javascript");
  const [hostStatus,   setHostStatus]   = useState({ connected: true, graceEndsAt: null });
  const [connected,    setConnected]    = useState(true);
  const [notice,       setNotice]       = useState("");

  // UI state
  const [probInput,    setProbInput]    = useState("");
  const [probLink,     setProbLink]     = useState("");
  const [copied,       setCopied]       = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [exported,     setExported]     = useState(false);
  const [showEndDlg,   setShowEndDlg]   = useState(false);
  const [mobileSide,   setMobileSide]   = useState(false);

  // Resizable panels: sidebar (participants) and chat
  const [sidebarW, onSidebarDrag] = useResize(224, 160, 400);  // default 224px (w-56)
  const [chatW,    onChatDrag]    = useResize(380, 220, 900);  // default 380px
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const socketRef = useRef(null);
  const selfUserIdRef = useRef(null);
  const noticeTimerRef = useRef(null);

  const showNotice = useCallback((message) => {
    setNotice(message);
    clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(""), 4000);
  }, []);

  useEffect(() => () => clearTimeout(noticeTimerRef.current), []);

  /* ── 1. Load identity ────────────────────────────────────────────────── */
  useEffect(() => {
    setIdentity(getOrCreateIdentity());
  }, []);

  /* ── 2. Connect socket + join room ───────────────────────────────────── */
  useEffect(() => {
    if (!identity || !roomId) return;

    const socket = getSocket();
    socketRef.current = socket;

    const dropCursor = (userId) => setRemoteCursors((prev) => {
      if (!prev[userId]) return prev;
      const next = { ...prev };
      delete next[userId];
      return next;
    });

    // ── handlers ──────────────────────────────────────────────────────────
    const onRoomJoined = ({ room, participants, messages, code, isHost: host, selfUserId: me, hostStatus: hs }) => {
      selfUserIdRef.current = me;
      setSelfUserId(me);
      setRoom(room);
      setParticipants(participants);
      setMessages(messages);
      setTypingUsers([]);
      setRemoteCursors({});
      setCode(code || "");
      setLanguage(room.language || "javascript");
      setIsHost(Boolean(host));
      setHostStatus(hs || { connected: true, graceEndsAt: null });
      setProbLink(room.problemLink || "");
      setConnected(true);
      setStatus(STATUS.ACTIVE);
    };

    const onReceiveMessage = (msg) => {
      setMessages((prev) => {
        if (prev.find((m) => m.id === msg.id)) return prev; // deduplicate
        return [...prev, msg];
      });
      if (msg.senderId) {
        setTypingUsers((prev) => prev.filter((u) => u.userId !== msg.senderId));
      }
    };

    const onCodeUpdated = ({ code: newCode }) => setCode(newCode);

    const onLanguageUpdated = ({ language: lang, changedBy }) => {
      setLanguage(lang);
      if (changedBy) showNotice(`${changedBy} switched the editor to ${lang}.`);
    };

    const onCursorUpdated = ({ userId, displayName, position, selection }) => {
      if (!userId || userId === selfUserIdRef.current) return;
      setRemoteCursors((prev) => ({
        ...prev,
        [userId]: { userId, displayName, position, selection },
      }));
    };

    const onCursorRemoved = ({ userId }) => {
      if (userId) dropCursor(userId);
    };

    const onReactionUpdated = ({ messageId, reactions }) => {
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, reactions } : m)));
    };

    const onTypingUpdate = ({ userId, displayName, isTyping }) => {
      setTypingUsers((prev) => {
        const filtered = prev.filter((u) => u.userId !== userId);
        if (!isTyping) return filtered;
        return [...filtered, { userId, displayName }];
      });
    };

    const onParticipantsUpdate = (list) => {
      setParticipants(list);
      const active = new Set(list.map((p) => p.userId));
      setRemoteCursors((prev) => {
        const next = {};
        for (const [userId, data] of Object.entries(prev)) {
          if (active.has(userId)) next[userId] = data;
        }
        return next;
      });
    };

    const onUserJoined = ({ userId, displayName }) => {
      setMessages((prev) => [...prev, systemMessage(`${displayName} joined the room`)]);
      setTypingUsers((prev) => prev.filter((u) => u.userId !== userId));
    };

    const onUserLeft = ({ userId, displayName }) => {
      setMessages((prev) => [...prev, systemMessage(`${displayName} left the room`)]);
      if (userId) {
        setTypingUsers((prev) => prev.filter((u) => u.userId !== userId));
        dropCursor(userId);
      }
    };

    const onProblemShared = ({ link }) => setProbLink(link);

    const onHostStatus = (hs) => setHostStatus(hs);

    const onRoomExpired = () => {
      setStatus(STATUS.EXPIRED);
    };

    // Fatal: the room could not be joined.
    const onRoomError = ({ message }) => {
      setErrorMsg(message);
      setStatus(STATUS.ERROR);
    };

    // Non-fatal: an action was rejected; stay in the room.
    const onActionError = ({ message }) => showNotice(message);

    const joinRoom = () => {
      socket.emit("join_room", {
        roomId,
        guestId:     identity.guestId,
        displayName: identity.displayName,
      });
    };

    // A fresh server-side socket after any reconnect is not in the room yet.
    const onConnect = () => joinRoom();
    const onDisconnect = () => setConnected(false);

    // ── register ──────────────────────────────────────────────────────────
    socket.on("connect",             onConnect);
    socket.on("disconnect",          onDisconnect);
    socket.on("room_joined",         onRoomJoined);
    socket.on("receive_message",     onReceiveMessage);
    socket.on("code_updated",        onCodeUpdated);
    socket.on("language_updated",    onLanguageUpdated);
    socket.on("cursor_updated",      onCursorUpdated);
    socket.on("cursor_removed",      onCursorRemoved);
    socket.on("reaction_updated",    onReactionUpdated);
    socket.on("typing_update",       onTypingUpdate);
    socket.on("participants_update", onParticipantsUpdate);
    socket.on("user_joined",         onUserJoined);
    socket.on("user_left",           onUserLeft);
    socket.on("problem_shared",      onProblemShared);
    socket.on("host_status",         onHostStatus);
    socket.on("room_expired",        onRoomExpired);
    socket.on("room_error",          onRoomError);
    socket.on("action_error",        onActionError);

    // ── join ──────────────────────────────────────────────────────────────
    if (socket.connected) joinRoom();

    return () => {
      socket.emit("leave_room");
      socket.off("connect",             onConnect);
      socket.off("disconnect",          onDisconnect);
      socket.off("room_joined",         onRoomJoined);
      socket.off("receive_message",     onReceiveMessage);
      socket.off("code_updated",        onCodeUpdated);
      socket.off("language_updated",    onLanguageUpdated);
      socket.off("cursor_updated",      onCursorUpdated);
      socket.off("cursor_removed",      onCursorRemoved);
      socket.off("reaction_updated",    onReactionUpdated);
      socket.off("typing_update",       onTypingUpdate);
      socket.off("participants_update", onParticipantsUpdate);
      socket.off("user_joined",         onUserJoined);
      socket.off("user_left",           onUserLeft);
      socket.off("problem_shared",      onProblemShared);
      socket.off("host_status",         onHostStatus);
      socket.off("room_expired",        onRoomExpired);
      socket.off("room_error",          onRoomError);
      socket.off("action_error",        onActionError);
    };
  }, [identity, roomId, showNotice]);

  /* ── Actions ─────────────────────────────────────────────────────────── */
  const sendMessage = useCallback((payload, replyTo = null) => {
    const isObjectPayload = payload && typeof payload === "object";
    const content = isObjectPayload ? String(payload.content || "") : String(payload || "");
    const type = isObjectPayload ? String(payload.type || "text") : "text";
    const attachment = isObjectPayload ? (payload.attachment || null) : null;

    socketRef.current?.emit("send_message", { content, type, attachment, replyTo });
    socketRef.current?.emit("typing_status", { isTyping: false });
  }, []);

  const handleTypingStatus = useCallback((isTyping) => {
    socketRef.current?.emit("typing_status", { isTyping });
  }, []);

  const toggleReaction = useCallback((messageId, emoji) => {
    if (!messageId || !emoji) return;
    socketRef.current?.emit("toggle_reaction", { messageId, emoji });
  }, []);

  const updateCode = useCallback((newCode) => {
    setCode(newCode);
    socketRef.current?.emit("code_update", { code: newCode });
  }, []);

  const changeLanguage = useCallback((lang) => {
    setLanguage(lang);
    socketRef.current?.emit("language_update", { language: lang });
  }, []);

  const emitCursorActivity = useCallback((cursorData) => {
    if (!cursorData) return;
    socketRef.current?.emit("cursor_update", {
      position: cursorData.position,
      selection: cursorData.selection,
    });
  }, []);

  const shareProblem = () => {
    const link = safeHttpUrl(probInput);
    if (!link) {
      showNotice("Problem link must be a full http(s) URL.");
      return;
    }
    socketRef.current?.emit("share_problem", { link });
    setProbInput("");
  };

  const handleEndRoom = () => {
    socketRef.current?.emit("end_room");
    setShowEndDlg(false);
  };

  const copyRoomId = async () => {
    await navigator.clipboard.writeText(roomId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const copyInviteLink = async () => {
    if (typeof window === "undefined" || !roomId) return;
    const mode = room?.roomType || "chat";
    const inviteUrl = `${window.location.origin}/?invite=${encodeURIComponent(roomId)}&mode=${encodeURIComponent(mode)}`;
    await navigator.clipboard.writeText(inviteUrl);
    setInviteCopied(true);
    setTimeout(() => setInviteCopied(false), 2000);
  };

  const exportSessionSnapshot = () => {
    if (!roomId) return;

    const lines = [];
    lines.push("BLIP SESSION SNAPSHOT");
    lines.push("======================");
    lines.push(`Room ID: ${roomId}`);
    lines.push(`Room Name: ${room?.roomName || "(unnamed)"}`);
    lines.push(`Room Type: ${room?.roomType || "unknown"}`);
    lines.push(`Created At: ${room?.createdAt ? new Date(room.createdAt).toISOString() : "unknown"}`);
    lines.push(`Exported At: ${new Date().toISOString()}`);
    lines.push("");

    lines.push("PARTICIPANTS");
    lines.push("------------");
    participants.forEach((p, i) => {
      const role = p.userId === room?.hostUserId ? "HOST" : "MEMBER";
      lines.push(`${i + 1}. ${p.displayName} (${role})`);
    });
    if (participants.length === 0) lines.push("(none)");
    lines.push("");

    lines.push("MESSAGES");
    lines.push("--------");
    messages.forEach((m) => {
      const when = m.timestamp ? new Date(m.timestamp).toISOString() : "unknown-time";
      if (m.type === "system") {
        lines.push(`[${when}] [SYSTEM] ${m.content}`);
        return;
      }

      const sender = m.senderName || "Unknown";
      const msgType = m.type || "text";
      const base = `[${when}] [${sender}] (${msgType}) ${m.content || ""}`;
      lines.push(base);

      if (m.replyTo?.content) {
        lines.push(`  ↳ reply to ${m.replyTo.senderName || "Unknown"}: ${m.replyTo.content}`);
      }

      if (m.reactions && Object.keys(m.reactions).length > 0) {
        const reactionSummary = Object.entries(m.reactions)
          .map(([emoji, users]) => `${emoji} x${Array.isArray(users) ? users.length : 0}`)
          .join(", ");
        lines.push(`  ↳ reactions: ${reactionSummary}`);
      }
    });
    if (messages.length === 0) lines.push("(none)");
    lines.push("");

    lines.push("CODE");
    lines.push("----");
    lines.push(code || "(empty)");
    lines.push("");

    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safeRoom = String(roomId).replace(/[^a-zA-Z0-9_-]/g, "_");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `blip-session-${safeRoom}-${ts}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setExported(true);
    setTimeout(() => setExported(false), 2000);
  };

  const goHome = () => {
    socketRef.current?.emit("leave_room");
    destroySocket();
    router.push("/");
  };

  /* ── Render: Loading ─────────────────────────────────────────────────── */
  if (status === STATUS.LOADING) {
    return (
      <div className="h-screen flex items-center justify-center flex-col gap-4" style={{ background: "#07070e" }}>
        <div className="w-10 h-10 rounded-full border-2 border-red-600 border-t-transparent animate-spin" />
        <p className="text-sm" style={{ color: "rgba(255,255,255,0.35)" }}>Joining room <span className="font-mono" style={{ color: "#f87171" }}>{roomId}</span>…</p>
      </div>
    );
  }

  /* ── Render: Error ───────────────────────────────────────────────────── */
  if (status === STATUS.ERROR) {
    return (
      <div className="h-screen flex items-center justify-center" style={{ background: "#07070e" }}>
        <div className="text-center max-w-sm mx-auto px-8 py-10 rounded-2xl" style={{ background: "#0e0e1c", border: "1px solid rgba(220,38,38,0.18)" }}>
          <div className="w-10 h-10 rounded-full flex items-center justify-center mx-auto mb-5" style={{ background: "rgba(220,38,38,0.1)", border: "1px solid rgba(220,38,38,0.25)" }}>
            <svg className="w-5 h-5 text-red-500" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" /></svg>
          </div>
          <h2 className="text-white text-xl font-semibold mb-3">Can't join room</h2>
          <p className="text-sm mb-7" style={{ color: "rgba(255,255,255,0.35)" }}>{errorMsg || "Room not found or has expired."}</p>
          <button onClick={goHome} className="blip-btn-red w-full">← Back to Home</button>
        </div>
      </div>
    );
  }

  /* ── Render: Expired overlay ─────────────────────────────────────────── */
  if (status === STATUS.EXPIRED) {
    return <SnapExpired roomType={room?.roomType} />
  }

  const isCoding = room?.roomType === "coding";
  const isPublicRoom = (room?.visibility || "private") === "public";

  /* ── Render: Active room ─────────────────────────────────────────────── */
  return (
    <>
      <Head>
        <title>Room {roomId} — Blip</title>
      </Head>

      {/* End Room Confirmation Dialog */}
      {showEndDlg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(4px)" }} onClick={() => setShowEndDlg(false)}>
          <div className="max-w-sm mx-4 px-7 py-8 rounded-2xl animate-slide-up" style={{ background: "#0e0e1c", border: "1px solid rgba(220,38,38,0.2)" }} onClick={(e) => e.stopPropagation()}>
            <h3 className="text-white font-semibold text-lg mb-2">End this room?</h3>
            <p className="text-sm mb-7" style={{ color: "rgba(255,255,255,0.35)" }}>
              All messages and code will be permanently deleted and all participants will be disconnected.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setShowEndDlg(false)} className="flex-1 py-2.5 rounded-lg text-sm font-medium transition-colors" style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.5)" }}>Cancel</button>
              <button onClick={handleEndRoom} className="blip-btn-red flex-1">End Room</button>
            </div>
          </div>
        </div>
      )}

      <div className="h-screen flex flex-col overflow-hidden" style={{ background: "#07070e" }}>
        {/* ── Header ────────────────────────────────────────────────────── */}
        <header className="flex-none min-h-14 flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2 md:py-0 flex-wrap md:flex-nowrap" style={{ background: "#0a0a14", borderBottom: "1px solid rgba(255,255,255,0.055)" }}>
          {/* Logo */}
          <button onClick={goHome} className="flex items-center gap-2 group flex-shrink-0">
            <span className="w-7 h-7 rounded-md flex items-center justify-center font-bold text-xs transition-opacity group-hover:opacity-75" style={{ background: "linear-gradient(135deg,#dc2626,#991b1b)", color: "#fff", fontFamily: "'Bebas Neue','Barlow Condensed',sans-serif", letterSpacing: "0.05em" }}>B</span>
            <span className="font-semibold text-sm hidden sm:block text-white" style={{ fontFamily: "'Bebas Neue','Barlow Condensed',sans-serif", letterSpacing: "0.12em" }}>BLIP</span>
          </button>

          <div className="w-px h-5 mx-1 flex-shrink-0" style={{ background: "rgba(255,255,255,0.07)" }} />

          {/* Invite link */}
          {!isPublicRoom && (
            <button
              onClick={copyInviteLink}
              className="flex items-center gap-1.5 transition-colors flex-shrink-0 hover:text-white"
              style={{ color: inviteCopied ? "#34d399" : "rgba(255,255,255,0.35)" }}
              title="Copy Invite Link"
            >
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                <path d="M12.59 7.41a1 1 0 010 1.41L10.41 11a1 1 0 01-1.41-1.41l2.17-2.18a1 1 0 011.42 0z" />
                <path d="M6.88 13.12a3 3 0 010-4.24l2.12-2.12a3 3 0 114.24 4.24l-.7.7a1 1 0 11-1.42-1.41l.7-.7a1 1 0 10-1.41-1.42L8.29 10.3a1 1 0 001.41 1.41 1 1 0 111.42 1.41 3 3 0 01-4.24 0z" />
              </svg>
              <span className="text-xs font-medium hidden sm:inline">{inviteCopied ? "Copied" : "Invite"}</span>
            </button>
          )}

          {/* Room ID + copy */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-xs hidden sm:block" style={{ color: "rgba(255,255,255,0.25)" }}>Room</span>
            <span className="font-mono font-semibold text-sm tracking-widest text-red-400">{roomId}</span>
            <button
              onClick={copyRoomId}
              className="text-gray-600 hover:text-gray-300 transition-colors"
              title="Copy Room ID"
            >
              {copied
                ? <svg className="w-3.5 h-3.5 text-emerald-400" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                : <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" /><path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z" /></svg>
              }
            </button>
          </div>

          {/* Room name (if set) */}
          {room?.roomName && (
            <span className="text-white font-medium text-sm truncate max-w-[180px] hidden sm:block" title={room.roomName}>
              {room.roomName}
            </span>
          )}

          {/* Room type badge */}
          <span className="flex-shrink-0 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider" style={isCoding ? { background: "rgba(220,38,38,0.1)", border: "1px solid rgba(220,38,38,0.25)", color: "#f87171" } : { background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.25)", color: "#fcd34d" }}>
            {isCoding ? "Coding" : "Chat"}
          </span>

          {isPublicRoom && (
            <span className="flex-shrink-0 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider" style={{ background: "rgba(16,185,129,0.1)", border: "1px solid rgba(16,185,129,0.3)", color: "#6ee7b7" }}>
              Public
            </span>
          )}

          <div className="flex-1" />

          {/* Timer */}
          {room?.expiresAt && (
            <div className="flex-shrink-0">
              <Timer expiresAt={room.expiresAt} />
            </div>
          )}

          <div className="w-px h-5 mx-1 flex-shrink-0 hidden md:block" style={{ background: "rgba(255,255,255,0.07)" }} />

          {/* Participant count */}
          <button
            onClick={() => setMobileSide(!mobileSide)}
            className="flex items-center gap-1.5 transition-colors flex-shrink-0 hover:text-white"
            style={{ color: "rgba(255,255,255,0.35)" }}
            title="Toggle participants"
          >
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z" />
            </svg>
            <span className="text-sm font-medium">{participants.length}</span>
          </button>

          {/* Host actions */}
          {isHost && (
            <>
              <button
                onClick={exportSessionSnapshot}
                className="ml-1 flex-shrink-0 px-3 py-1.5 text-xs font-semibold rounded-lg uppercase tracking-wider transition-all"
                style={exported
                  ? { background: "rgba(16,185,129,0.22)", border: "1px solid rgba(16,185,129,0.35)", color: "#6ee7b7" }
                  : { background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.28)", color: "#fcd34d" }
                }
              >
                {exported ? "Exported" : "Export"}
              </button>
              <button
                onClick={() => setShowEndDlg(true)}
                className="ml-1 flex-shrink-0 px-3 py-1.5 text-xs font-semibold rounded-lg uppercase tracking-wider transition-all"
                style={{ background: "rgba(220,38,38,0.12)", border: "1px solid rgba(220,38,38,0.28)", color: "#f87171" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(220,38,38,0.22)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(220,38,38,0.12)"; }}
              >
                End Room
              </button>
            </>
          )}
        </header>

        {!connected && (
          <div className="flex-none px-4 py-1.5 text-xs text-center" style={{ background: "rgba(220,38,38,0.12)", borderBottom: "1px solid rgba(220,38,38,0.25)", color: "#fca5a5" }}>
            Connection lost. Reconnecting…
          </div>
        )}
        {connected && !isPublicRoom && !hostStatus.connected && hostStatus.graceEndsAt && (
          <HostAwayBanner graceEndsAt={hostStatus.graceEndsAt} />
        )}

        {notice && (
          <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 max-w-[90vw] px-4 py-2.5 rounded-lg text-sm animate-slide-up" role="status" style={{ background: "#1a0b0b", border: "1px solid rgba(220,38,38,0.35)", color: "#fecaca", boxShadow: "0 8px 30px rgba(0,0,0,0.5)" }}>
            {notice}
          </div>
        )}

        {/* ── Body ──────────────────────────────────────────────────────── */}
        <div className="flex-1 flex overflow-hidden">

          {/* Left Sidebar — resizable */}
          <aside
            style={{
              width: sidebarCollapsed ? 40 : sidebarW,
              minWidth: sidebarCollapsed ? 40 : 160,
              maxWidth: sidebarCollapsed ? 40 : 400,
              background: "#0a0a14",
              borderRight: "1px solid rgba(255,255,255,0.055)",
              transition: "width 200ms ease, min-width 200ms ease",
            }}
            className={`flex-none flex flex-col overflow-hidden ${mobileSide ? "flex" : "hidden md:flex"}`}
          >
            {/* Participants */}
            <div className="flex-1 overflow-hidden">
              <ParticipantList
                participants={participants}
                hostUserId={room?.hostUserId}
                currentUserId={selfUserId}
                collapsed={sidebarCollapsed}
                onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
              />
            </div>

            {/* Problem Link Section — coding rooms only */}
            {isCoding && !sidebarCollapsed && (
            <div className="p-3 flex-none" style={{ borderTop: "1px solid rgba(255,255,255,0.055)" }}>
              <p className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: "rgba(255,255,255,0.22)" }}>
                Problem Link
              </p>

              {safeHttpUrl(probLink) && (
                <a
                  href={safeHttpUrl(probLink)}
                  target="_blank"
                  rel="noreferrer"
                  className="block text-xs truncate mb-2 hover:text-white transition-colors text-red-400"
                  title={probLink}
                >
                  {probLink.replace(/^https?:\/\//, "").replace(/^www\./, "")}
                </a>
              )}

              {isHost && (
                <div className="flex gap-1">
                  <input
                    className="flex-1 blip-input text-xs py-1.5 px-2"
                    placeholder="Paste LeetCode / GFG / CF link…"
                    value={probInput}
                    onChange={(e) => setProbInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") shareProblem(); }}
                  />
                  <button
                    onClick={shareProblem}
                    disabled={!probInput.trim()}
                    className="px-2 py-1 text-xs rounded flex-shrink-0 transition-colors disabled:opacity-30"
                    style={{ background: "rgba(220,38,38,0.1)", border: "1px solid rgba(220,38,38,0.25)", color: "#f87171" }}
                    title="Share"
                  >
                    ↑
                  </button>
                </div>
              )}

              {!isHost && !probLink && (
                <p className="text-xs italic" style={{ color: "rgba(255,255,255,0.2)" }}>Waiting for host to share a problem…</p>
              )}
            </div>
            )}
          </aside>

          {/* Drag divider: sidebar | chat */}
          {!sidebarCollapsed && (
            <div className="hidden md:flex">
              <ResizeDivider onMouseDown={onSidebarDrag} />
            </div>
          )}

          {/* Main content */}
          <div className="flex-1 flex overflow-hidden min-w-0">

            {/* Chat Panel — resizable (coding rooms only; full width for chat rooms) */}
            <div
              style={isCoding ? { width: chatW, minWidth: 220, maxWidth: 900 } : {}}
              className={`flex flex-col overflow-hidden ${isCoding ? "flex-none" : "flex-1"}`}
            >
              <div className="px-4 py-2 flex-none" style={{ borderBottom: "1px solid rgba(255,255,255,0.055)", background: "#0a0a14" }}>
                <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: "rgba(255,255,255,0.22)" }}>
                  Chat
                </span>
              </div>
              <div className="flex-1 overflow-hidden">
                <ChatPanel
                  messages={messages}
                  onSendMessage={sendMessage}
                  onTypingChange={handleTypingStatus}
                  typingUsers={typingUsers}
                  onToggleReaction={toggleReaction}
                  currentUserId={selfUserId}
                />
              </div>
            </div>

            {/* Drag divider: chat | editor */}
            {isCoding && <ResizeDivider onMouseDown={onChatDrag} />}

            {/* Code Editor Panel (coding rooms only) */}
            {isCoding && (
              <div className="flex-1 flex flex-col overflow-hidden min-w-0">
                <CodeEditor
                  code={code}
                  onCodeChange={updateCode}
                  language={language}
                  onLanguageChange={changeLanguage}
                  roomId={roomId}
                  guestId={identity?.guestId}
                  currentUserId={selfUserId}
                  remoteCursors={remoteCursors}
                  onCursorActivity={emitCursorActivity}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
