import { useState, useEffect, useRef, useCallback } from "react";
import { safeHttpUrl, isSameOrigin } from "../lib/url";
import { attachmentUrl } from "../lib/config";

const QUICK_REACTIONS = ["👍", "🔥", "😂", "👏", "💡"];
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

function formatDuration(totalSec = 0) {
  const sec = Math.max(0, Math.floor(totalSec));
  const mm = String(Math.floor(sec / 60)).padStart(2, "0");
  const ss = String(sec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function formatSize(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function getYouTubeEmbedUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();

    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return id ? `https://www.youtube.com/embed/${id}` : null;
    }

    if (host === "youtube.com" || host === "m.youtube.com") {
      if (url.pathname === "/watch") {
        const id = url.searchParams.get("v");
        return id ? `https://www.youtube.com/embed/${id}` : null;
      }
      if (url.pathname.startsWith("/shorts/")) {
        const id = url.pathname.split("/")[2];
        return id ? `https://www.youtube.com/embed/${id}` : null;
      }
      if (url.pathname.startsWith("/embed/")) {
        const id = url.pathname.split("/")[2];
        return id ? `https://www.youtube.com/embed/${id}` : null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function isImageUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function getLinkPreviewType(rawUrl) {
  if (getYouTubeEmbedUrl(rawUrl)) return "youtube";
  if (isImageUrl(rawUrl)) return "image";
  return "web";
}

function canUseSidePreview() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(min-width: 1024px)").matches;
}

function linkify(text, onLinkClick = null) {
  // Simple URL detection — for problem links
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.split(urlRegex).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noreferrer"
        className="text-red-400 underline underline-offset-2 hover:text-white break-all"
        onClick={(e) => {
          if (!onLinkClick) return;
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          if (!canUseSidePreview()) return;
          e.preventDefault();
          onLinkClick(part);
        }}
      >
        {part}
      </a>
    ) : part
  );
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read file."));
    reader.readAsDataURL(file);
  });
}

function pickAudioMimeType() {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || "";
}

// ── Message Bubble ──────────────────────────────────────────────────────────
function MessageBubble({ msg, isOwn, onReply, onToggleReaction, currentUserId, onOpenLinkPreview }) {
  if (msg.type === "system") {
    return (
      <div className="flex justify-center my-1">
        <span className="text-xs px-3 py-0.5 rounded-full italic" style={{ color: "rgba(255,255,255,0.22)", background: "rgba(255,255,255,0.04)" }}>
          {msg.content}
        </span>
      </div>
    );
  }

  if (msg.type === "problem_link") {
    const href = safeHttpUrl(msg.content);
    return (
      <div className={`flex ${isOwn ? "justify-end" : "justify-start"} mb-2 msg-enter`}>
        <div className="max-w-[85%] rounded-xl px-4 py-3" style={{ background: "rgba(220,38,38,0.08)", border: "1px solid rgba(220,38,38,0.22)" }}>
          <p className="text-xs font-medium mb-1.5 text-red-400">
            Problem shared by {msg.senderName}
          </p>
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-white underline underline-offset-2 hover:text-red-300 break-all"
              onClick={(e) => {
                if (!onOpenLinkPreview) return;
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                if (!canUseSidePreview()) return;
                e.preventDefault();
                onOpenLinkPreview(href);
              }}
            >
              {msg.content}
            </a>
          ) : (
            <span className="text-sm text-white break-all">{msg.content}</span>
          )}
        </div>
      </div>
    );
  }

  if (msg.type === "attachment") {
    const attachment = msg.attachment || {};
    const fileUrl = attachmentUrl(msg.roomId, attachment.id);
    const isImage = attachment.kind === "image" && fileUrl;
    const isAudio = attachment.kind === "audio" && fileUrl;
    return (
      <div className={`flex items-end gap-2 mb-2 msg-enter ${isOwn ? "flex-row-reverse" : "flex-row"}`}>
        {!isOwn && (
          <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs flex-shrink-0 mb-0.5" style={{ background: "rgba(255,255,255,0.07)", color: "rgba(255,255,255,0.6)" }}>
            {msg.senderName?.[0] ?? "?"}
          </div>
        )}

        <div className={`flex flex-col ${isOwn ? "items-end" : "items-start"} max-w-[82%]`}>
          <div
            className={`px-3.5 py-2 rounded-2xl ${isOwn ? "rounded-br-sm" : "rounded-bl-sm"}`}
            style={isOwn
              ? { background: "linear-gradient(135deg,#dc2626,#b91c1c)", color: "#fff" }
              : { background: "#0e0e1c", border: "1px solid rgba(255,255,255,0.07)", color: "rgba(255,255,255,0.85)" }
            }
          >
            {msg.replyTo && (
              <div
                className="mb-2 px-2 py-1 rounded-lg"
                style={{ borderLeft: "2px solid rgba(255,255,255,0.25)", background: "rgba(0,0,0,0.18)" }}
              >
                <p className="text-[10px] font-semibold" style={{ color: "rgba(255,255,255,0.72)" }}>
                  Replying to {msg.replyTo.senderName}
                </p>
                <p className="text-[11px] truncate" style={{ color: "rgba(255,255,255,0.62)" }}>
                  {msg.replyTo.content}
                </p>
              </div>
            )}

            {isImage ? (
              <a href={fileUrl} target="_blank" rel="noreferrer" title="Open image">
                <img
                  src={fileUrl}
                  loading="lazy"
                  alt={attachment.fileName || "image"}
                  className="rounded-lg max-h-[240px] object-contain"
                  style={{ border: "1px solid rgba(255,255,255,0.16)", background: "rgba(0,0,0,0.2)" }}
                />
              </a>
            ) : isAudio ? (
              <div
                className="rounded-xl px-3 py-2.5"
                style={{
                  background: "linear-gradient(180deg,rgba(255,255,255,0.10),rgba(255,255,255,0.06))",
                  border: "1px solid rgba(255,255,255,0.18)",
                  minWidth: 260,
                  maxWidth: 360,
                }}
              >
                <div className="flex items-center gap-2 mb-2">
                  <span
                    className="w-6 h-6 rounded-full flex items-center justify-center text-xs"
                    style={{ background: "rgba(34,197,94,0.18)", color: "#86efac" }}
                    aria-hidden
                  >
                    ♪
                  </span>
                  <p className="text-xs font-semibold" style={{ color: "rgba(255,255,255,0.86)" }}>
                    Voice Note
                  </p>
                  <span className="text-[10px] ml-auto" style={{ color: "rgba(255,255,255,0.52)" }}>
                    {formatSize(attachment.size || 0)}
                  </span>
                </div>
                <audio controls preload="metadata" src={fileUrl} className="w-full h-9" />
                {Number.isFinite(Number(attachment.durationSec)) && Number(attachment.durationSec) > 0 && (
                  <p className="mt-1 text-[10px]" style={{ color: "rgba(255,255,255,0.55)" }}>
                    Duration: {formatDuration(Number(attachment.durationSec))}
                  </p>
                )}
              </div>
            ) : (
              <a
                href={fileUrl || undefined}
                download={attachment.fileName || "attachment"}
                className="flex items-center gap-2 rounded-lg px-2.5 py-2 transition-colors"
                style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.16)" }}
                title="Download attachment"
              >
                <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M9 2a1 1 0 012 0v8.59l2.3-2.3a1 1 0 111.4 1.42l-4 4a1 1 0 01-1.4 0l-4-4a1 1 0 011.4-1.42L9 10.6V2z" />
                  <path d="M3 14a1 1 0 011 1v1h12v-1a1 1 0 112 0v2a1 1 0 01-1 1H3a1 1 0 01-1-1v-2a1 1 0 011-1z" />
                </svg>
                <div className="min-w-0">
                  <p className="text-xs font-semibold truncate">{attachment.fileName || "attachment"}</p>
                  <p className="text-[10px]" style={{ color: "rgba(255,255,255,0.65)" }}>{formatSize(attachment.size || 0)}</p>
                </div>
              </a>
            )}

            {msg.content ? (
              <p className="text-sm leading-relaxed mt-2">{linkify(msg.content, onOpenLinkPreview)}</p>
            ) : null}
          </div>

          <div className={`flex items-center gap-1.5 mt-0.5 mx-1 ${isOwn ? "flex-row-reverse" : "flex-row"}`}>
            <span className="text-[10px]" style={{ color: "rgba(255,255,255,0.18)" }}>{formatTime(msg.timestamp)}</span>
            <span className="text-[10px]" style={{ color: "rgba(255,255,255,0.28)" }}>·</span>
            <span className="text-[10px]" style={{ color: "rgba(255,255,255,0.28)" }}>{msg.senderName}</span>
            <button
              onClick={() => onReply(msg)}
              className="text-[10px] px-1.5 py-0.5 rounded-md"
              style={{ color: "rgba(255,255,255,0.45)", background: "rgba(255,255,255,0.03)" }}
              title="Reply"
            >
              Reply
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex items-end gap-2 mb-2 msg-enter ${isOwn ? "flex-row-reverse" : "flex-row"}`}>
      {/* Sender avatar (others only) */}
      {!isOwn && (
        <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs flex-shrink-0 mb-0.5" style={{ background: "rgba(255,255,255,0.07)", color: "rgba(255,255,255,0.6)" }}>
          {msg.senderName?.[0] ?? "?"}
        </div>
      )}
      <div className={`flex flex-col ${isOwn ? "items-end" : "items-start"} max-w-[80%]`}>
        <div
          className={`px-3.5 py-2 rounded-2xl text-sm leading-relaxed ${
            isOwn ? "rounded-br-sm" : "rounded-bl-sm"
          }`}
          style={isOwn
            ? { background: "linear-gradient(135deg,#dc2626,#b91c1c)", color: "#fff" }
            : { background: "#0e0e1c", border: "1px solid rgba(255,255,255,0.07)", color: "rgba(255,255,255,0.85)" }
          }
        >
          {msg.replyTo && (
            <div
              className="mb-2 px-2 py-1 rounded-lg"
              style={{
                borderLeft: "2px solid rgba(255,255,255,0.25)",
                background: "rgba(0,0,0,0.18)",
              }}
            >
              <p className="text-[10px] font-semibold" style={{ color: "rgba(255,255,255,0.72)" }}>
                Replying to {msg.replyTo.senderName}
              </p>
              <p className="text-[11px] truncate" style={{ color: "rgba(255,255,255,0.62)" }}>
                {msg.replyTo.content}
              </p>
            </div>
          )}
          {linkify(msg.content, onOpenLinkPreview)}
        </div>
        <div className={`flex items-center gap-1.5 mt-0.5 mx-1 ${isOwn ? "flex-row-reverse" : "flex-row"}`}>
          <span className="text-[10px]" style={{ color: "rgba(255,255,255,0.18)" }}>{formatTime(msg.timestamp)}</span>
          <span className="text-[10px]" style={{ color: "rgba(255,255,255,0.28)" }}>·</span>
          <span className="text-[10px]" style={{ color: "rgba(255,255,255,0.28)" }}>{msg.senderName}</span>
        </div>

        {msg.type === "text" && (
          <div className={`flex items-center flex-wrap gap-1 mt-1 mx-1 ${isOwn ? "justify-end" : "justify-start"}`}>
            {Object.entries(msg.reactions || {}).map(([emoji, users]) => {
              const reacted = Array.isArray(users) && users.includes(currentUserId);
              const count = Array.isArray(users) ? users.length : 0;
              if (!count) return null;
              return (
                <button
                  key={emoji}
                  onClick={() => onToggleReaction(msg.id, emoji)}
                  className="text-[11px] px-1.5 py-0.5 rounded-md transition-colors"
                  style={reacted
                    ? { background: "rgba(220,38,38,0.22)", border: "1px solid rgba(220,38,38,0.4)", color: "#fff" }
                    : { background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.11)", color: "rgba(255,255,255,0.72)" }
                  }
                  title="Toggle reaction"
                >
                  {emoji} {count}
                </button>
              );
            })}

            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={`${msg.id}-${emoji}`}
                onClick={() => onToggleReaction(msg.id, emoji)}
                className="text-[11px] px-1.5 py-0.5 rounded-md transition-colors"
                style={{ background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.5)" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(220,38,38,0.18)"; e.currentTarget.style.color = "#fff"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.04)"; e.currentTarget.style.color = "rgba(255,255,255,0.5)"; }}
                title={`React ${emoji}`}
              >
                {emoji}
              </button>
            ))}

            <button
              onClick={() => onReply(msg)}
              className="text-[10px] px-1.5 py-0.5 rounded-md"
              style={{ color: "rgba(255,255,255,0.45)", background: "rgba(255,255,255,0.03)" }}
              title="Reply"
            >
              Reply
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Chat Panel ──────────────────────────────────────────────────────────────
export default function ChatPanel({
  messages = [],
  onSendMessage,
  currentUserId,
  onTypingChange = () => {},
  typingUsers = [],
  onToggleReaction = () => {},
}) {
  const [text, setText] = useState("");
  const [replyTarget, setReplyTarget] = useState(null);
  const [pendingAttachment, setPendingAttachment] = useState(null);
  const [attachErr, setAttachErr] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [recordSec, setRecordSec] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [linkPreview, setLinkPreview] = useState(null);
  const [linkPreviewWidth, setLinkPreviewWidth] = useState(360);
  const bottomRef = useRef(null);
  const typingRef = useRef(false);
  const idleTimerRef = useRef(null);
  const fileInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recordChunksRef = useRef([]);
  const recordStreamRef = useRef(null);
  const recordTimerRef = useRef(null);
  const recordSecRef = useRef(0);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const meterRafRef = useRef(null);
  const previewDragHandlersRef = useRef({ onMove: null, onUp: null });

  // Auto-scroll to bottom on new message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (typingRef.current) onTypingChange(false);
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      if (meterRafRef.current) cancelAnimationFrame(meterRafRef.current);
      if (sourceNodeRef.current) sourceNodeRef.current.disconnect();
      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
        audioContextRef.current.close();
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      if (recordStreamRef.current) {
        recordStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (previewDragHandlersRef.current.onMove) {
        window.removeEventListener("mousemove", previewDragHandlersRef.current.onMove);
      }
      if (previewDragHandlersRef.current.onUp) {
        window.removeEventListener("mouseup", previewDragHandlersRef.current.onUp);
      }
    };
  }, [onTypingChange]);

  const setTyping = (next) => {
    if (typingRef.current === next) return;
    typingRef.current = next;
    onTypingChange(next);
  };

  const onTextChange = (value) => {
    setText(value);
    if (!value.trim()) {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      setTyping(false);
      return;
    }

    setTyping(true);
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setTyping(false), 1200);
  };

  const handleSend = () => {
    if (isRecording) {
      setAttachErr("Stop recording before sending.");
      return;
    }

    const trimmed = text.trim();
    if (!trimmed && !pendingAttachment) return;
    const replyTo = replyTarget
      ? {
          id: replyTarget.id,
          senderName: replyTarget.senderName,
          content: replyTarget.content,
          type: replyTarget.type,
        }
      : null;

    if (pendingAttachment) {
      onSendMessage({
        type: "attachment",
        content: trimmed,
        attachment: pendingAttachment,
      }, replyTo);
    } else {
      onSendMessage(trimmed, replyTo);
    }

    setText("");
    setReplyTarget(null);
    setPendingAttachment(null);
    setAttachErr("");
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    setTyping(false);
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handlePickAttachment = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_ATTACHMENT_BYTES) {
      setAttachErr("File too large. Max 3MB.");
      setPendingAttachment(null);
      return;
    }

    try {
      const dataUrl = await readFileAsDataUrl(file);
      setPendingAttachment({
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        dataUrl,
        kind: file.type.startsWith("image/") ? "image" : file.type.startsWith("audio/") ? "audio" : "file",
      });
      setAttachErr("");
    } catch (err) {
      setAttachErr(err.message || "Unable to read selected file.");
      setPendingAttachment(null);
    }
  };

  const stopMicMeter = useCallback(() => {
    if (meterRafRef.current) {
      cancelAnimationFrame(meterRafRef.current);
      meterRafRef.current = null;
    }

    if (sourceNodeRef.current) {
      try { sourceNodeRef.current.disconnect(); } catch {}
      sourceNodeRef.current = null;
    }

    analyserRef.current = null;

    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close();
    }
    audioContextRef.current = null;
    setMicLevel(0);
  }, []);

  const startMicMeter = useCallback((stream) => {
    stopMicMeter();

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;

    const ctx = new Ctx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.78;

    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);

    audioContextRef.current = ctx;
    analyserRef.current = analyser;
    sourceNodeRef.current = source;

    const data = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      if (!analyserRef.current) return;
      analyserRef.current.getByteTimeDomainData(data);

      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      const normalized = Math.min(1, Math.max(0, rms * 2.2));
      setMicLevel(normalized);

      meterRafRef.current = requestAnimationFrame(tick);
    };

    meterRafRef.current = requestAnimationFrame(tick);
  }, [stopMicMeter]);

  const startRecording = async () => {
    try {
      setAttachErr("");
      setPendingAttachment(null);
      if (fileInputRef.current) fileInputRef.current.value = "";

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      let recorder;
      const preferredMime = pickAudioMimeType();
      try {
        recorder = preferredMime ? new MediaRecorder(stream, { mimeType: preferredMime }) : new MediaRecorder(stream);
      } catch {
        recorder = new MediaRecorder(stream);
      }
      recordStreamRef.current = stream;
      startMicMeter(stream);
      mediaRecorderRef.current = recorder;
      recordChunksRef.current = [];
      setRecordSec(0);
      recordSecRef.current = 0;

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          recordChunksRef.current.push(ev.data);
        }
      };

      recorder.onstop = async () => {
        try {
          const blob = new Blob(recordChunksRef.current, { type: recorder.mimeType || "audio/webm" });
          if (blob.size <= 0) return;
          if (blob.size > MAX_ATTACHMENT_BYTES) {
            setAttachErr("Voice note too large. Max 3MB.");
            return;
          }

          const dataUrl = await readFileAsDataUrl(blob);
          const mimeType = blob.type || recorder.mimeType || "audio/webm";
          const ext = mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm";
          setPendingAttachment({
            fileName: `voice-note-${Date.now()}.${ext}`,
            mimeType,
            size: blob.size,
            dataUrl,
            kind: "audio",
            durationSec: recordSecRef.current,
          });
          if (recordSecRef.current <= 0) {
            setAttachErr("Recorded too short. Hold record for at least 1 second.");
          }
        } finally {
          stopMicMeter();
          if (recordStreamRef.current) {
            recordStreamRef.current.getTracks().forEach((t) => t.stop());
            recordStreamRef.current = null;
          }
        }
      };

      recorder.start();
      setIsRecording(true);
      recordTimerRef.current = setInterval(() => {
        setRecordSec((s) => {
          const next = s + 1;
          recordSecRef.current = next;
          return next;
        });
      }, 1000);
    } catch (_err) {
      stopMicMeter();
      setAttachErr("Microphone permission denied or unavailable.");
    }
  };

  const stopRecording = () => {
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    setIsRecording(false);

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }

    stopMicMeter();
  };

  const openLinkPreview = useCallback((url) => {
    if (!url || typeof url !== "string") return;
    const cleanUrl = safeHttpUrl(url);
    if (!cleanUrl) return;
    // Never embed this app itself: a scripted same-origin iframe could escape its sandbox.
    if (isSameOrigin(cleanUrl)) {
      window.open(cleanUrl, "_blank", "noopener,noreferrer");
      return;
    }

    const type = getLinkPreviewType(cleanUrl);
    const embedUrl = type === "youtube" ? getYouTubeEmbedUrl(cleanUrl) : cleanUrl;
    let title = cleanUrl;
    try {
      title = new URL(cleanUrl).hostname.replace(/^www\./, "");
    } catch {
      // Keep raw URL as title on parsing error.
    }

    setLinkPreview({
      url: cleanUrl,
      type,
      embedUrl,
      title,
    });
  }, []);

  const beginLinkPreviewResize = useCallback((e) => {
    if (typeof window === "undefined") return;
    e.preventDefault();

    const startX = e.clientX;
    const startWidth = linkPreviewWidth;

    const onMove = (ev) => {
      const delta = startX - ev.clientX;
      const maxByViewport = Math.max(320, window.innerWidth - 220);
      const next = Math.max(280, Math.min(760, Math.min(maxByViewport, startWidth + delta)));
      setLinkPreviewWidth(next);
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      previewDragHandlersRef.current = { onMove: null, onUp: null };
    };

    previewDragHandlersRef.current = { onMove, onUp };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [linkPreviewWidth]);

  return (
    <div className="flex flex-col h-full relative">
      {/* Messages */}
      <div
        className="flex-1 overflow-y-auto px-4 py-4 space-y-0.5"
        style={linkPreview ? { paddingRight: linkPreviewWidth + 24 } : undefined}
      >
        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <p className="text-sm" style={{ color: "rgba(255,255,255,0.18)" }}>No messages yet. Start the conversation.</p>
          </div>
        ) : (
          messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              msg={msg}
              isOwn={Boolean(currentUserId) && msg.senderId === currentUserId}
              currentUserId={currentUserId}
              onToggleReaction={onToggleReaction}
              onReply={(sourceMsg) => setReplyTarget(sourceMsg)}
              onOpenLinkPreview={openLinkPreview}
            />
          ))
        )}

        {typingUsers.length > 0 && (
          <div className="px-1 pb-2">
            <p className="text-xs italic" style={{ color: "rgba(255,255,255,0.34)" }}>
              {typingUsers.slice(0, 2).map((u) => u.displayName).join(", ")}
              {typingUsers.length > 2 ? ` +${typingUsers.length - 2} others` : ""} typing...
            </p>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-4 py-3 flex gap-2 items-end" style={{ borderTop: "1px solid rgba(255,255,255,0.055)" }}>
        <div className="flex-1 flex flex-col gap-2">
          {replyTarget && (
            <div
              className="px-3 py-2 rounded-lg text-xs flex items-start justify-between gap-3"
              style={{ background: "rgba(220,38,38,0.08)", border: "1px solid rgba(220,38,38,0.2)" }}
            >
              <div className="min-w-0">
                <p className="font-semibold text-red-400">Replying to {replyTarget.senderName}</p>
                <p className="truncate" style={{ color: "rgba(255,255,255,0.72)" }}>{replyTarget.content}</p>
              </div>
              <button
                onClick={() => setReplyTarget(null)}
                className="text-xs"
                style={{ color: "rgba(255,255,255,0.45)" }}
                title="Cancel reply"
              >
                Cancel
              </button>
            </div>
          )}

          {pendingAttachment && (
            <div
              className="px-3 py-2 rounded-lg text-xs flex items-start justify-between gap-3"
              style={{ background: "rgba(59,130,246,0.1)", border: "1px solid rgba(59,130,246,0.28)" }}
            >
              <div className="min-w-0">
                <p className="font-semibold" style={{ color: "#93c5fd" }}>
                  {pendingAttachment.kind === "image"
                    ? "Image ready"
                    : pendingAttachment.kind === "audio"
                      ? "Voice note ready"
                      : "File ready"}
                </p>
                <p className="truncate" style={{ color: "rgba(255,255,255,0.72)" }}>
                  {pendingAttachment.fileName} ({formatSize(pendingAttachment.size)})
                </p>
              </div>
              <button
                onClick={() => {
                  setPendingAttachment(null);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
                className="text-xs"
                style={{ color: "rgba(255,255,255,0.45)" }}
                title="Remove attachment"
              >
                Remove
              </button>
            </div>
          )}

          {attachErr && (
            <p className="text-[11px]" style={{ color: "#fca5a5" }}>{attachErr}</p>
          )}

          {isRecording && (
            <div
              className="px-3 py-2 rounded-lg text-xs flex items-center justify-between gap-3"
              style={{ background: "rgba(220,38,38,0.1)", border: "1px solid rgba(220,38,38,0.28)" }}
            >
              <div className="flex-1 min-w-0">
                <p style={{ color: "#fca5a5" }}>Recording voice note... {formatDuration(recordSec)}</p>
                <div className="mt-1 h-1.5 w-full rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.12)" }}>
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${Math.max(4, Math.round(micLevel * 100))}%`, background: "linear-gradient(90deg,#22c55e,#f59e0b,#ef4444)" }}
                  />
                </div>
              </div>
              <button
                onClick={stopRecording}
                className="px-2 py-1 rounded"
                style={{ background: "rgba(255,255,255,0.08)", color: "#fff" }}
                title="Stop recording"
              >
                Stop
              </button>
            </div>
          )}

        <textarea
          className="flex-1 blip-input resize-none min-h-[40px] max-h-[120px] py-2 leading-snug"
          rows={1}
          placeholder="Type a message… (Enter to send)"
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={handleKey}
        />
        </div>

        <input
          ref={fileInputRef}
          type="file"
          onChange={handlePickAttachment}
          className="hidden"
          accept="image/*,audio/*,.pdf,.txt,.md,.json,.csv,.zip,.rar,.doc,.docx,.ppt,.pptx,.xls,.xlsx"
        />

        <button
          onClick={() => fileInputRef.current?.click()}
          className="px-2.5 py-2.5 rounded-lg flex-shrink-0 self-end transition-all"
          style={{ background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.72)" }}
          title="Attach file/image"
        >
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            <path d="M8.6 13.4a3 3 0 004.24 0l3.18-3.18a3 3 0 00-4.24-4.24l-3.53 3.54a1 1 0 101.41 1.41l3.54-3.53a1 1 0 111.41 1.41l-3.18 3.18a1 1 0 01-1.41 0L6.48 8.48a3 3 0 114.24-4.24l.35.35a1 1 0 101.41-1.41l-.35-.35A5 5 0 105.07 9.9l3.53 3.5z" />
          </svg>
        </button>

        <button
          onClick={() => (isRecording ? stopRecording() : startRecording())}
          className="px-2.5 py-2.5 rounded-lg flex-shrink-0 self-end transition-all"
          style={isRecording
            ? { background: "rgba(220,38,38,0.22)", color: "#fca5a5" }
            : { background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.72)" }
          }
          title={isRecording ? "Stop voice recording" : "Record voice note"}
        >
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            {isRecording
              ? <path d="M6 6h8v8H6z" />
              : <path d="M10 3a3 3 0 00-3 3v4a3 3 0 106 0V6a3 3 0 00-3-3zM5 9a1 1 0 112 0 3 3 0 006 0 1 1 0 112 0 5 5 0 01-4 4.9V16h2a1 1 0 110 2H7a1 1 0 010-2h2v-2.1A5 5 0 015 9z" />}
          </svg>
        </button>

        <button
          onClick={handleSend}
          disabled={isRecording || (!text.trim() && !pendingAttachment)}
          className="px-3 py-2.5 rounded-lg flex-shrink-0 self-end transition-all disabled:opacity-30"
          style={{ background: "linear-gradient(135deg,#dc2626,#b91c1c)", color: "#fff" }}
          title="Send"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {linkPreview && (
        <aside
          className="hidden lg:flex flex-col absolute inset-y-0 right-0"
          style={{
            width: linkPreviewWidth,
            borderLeft: "1px solid rgba(255,255,255,0.08)",
            background: "#090913",
          }}
        >
          <button
            type="button"
            onMouseDown={beginLinkPreviewResize}
            className="absolute -left-1 top-0 bottom-0 w-2 cursor-col-resize group"
            title="Drag to resize preview panel"
            aria-label="Resize link preview panel"
          >
            <span className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-transparent group-hover:bg-red-400/80 transition-colors" />
          </button>

          <div className="px-3 py-2.5 flex items-center gap-2" style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-wider" style={{ color: "rgba(255,255,255,0.42)" }}>Link Preview</p>
              <p className="text-xs truncate" style={{ color: "rgba(255,255,255,0.8)" }}>{linkPreview.title}</p>
            </div>
            <a
              href={linkPreview.url}
              target="_blank"
              rel="noreferrer"
              className="ml-auto text-[11px] px-2 py-1 rounded"
              style={{ background: "rgba(255,255,255,0.07)", color: "rgba(255,255,255,0.8)" }}
            >
              Open
            </a>
            <button
              onClick={() => setLinkPreview(null)}
              className="text-[11px] px-2 py-1 rounded"
              style={{ background: "rgba(220,38,38,0.2)", color: "#fecaca" }}
              title="Close preview"
            >
              Close
            </button>
          </div>

          <div className="flex-1 min-h-0 p-2">
            {linkPreview.type === "youtube" ? (
              <iframe
                src={linkPreview.embedUrl}
                title="YouTube preview"
                className="w-full h-full rounded-lg"
                style={{ border: "1px solid rgba(255,255,255,0.08)", background: "#000" }}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            ) : linkPreview.type === "image" ? (
              <div className="w-full h-full rounded-lg overflow-hidden flex items-center justify-center" style={{ border: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.02)" }}>
                <img src={linkPreview.embedUrl} alt="Link preview" className="max-w-full max-h-full object-contain" />
              </div>
            ) : (
              <iframe
                src={linkPreview.embedUrl}
                title="Website preview"
                className="w-full h-full rounded-lg"
                style={{ border: "1px solid rgba(255,255,255,0.08)", background: "#05050b" }}
                sandbox="allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts"
                referrerPolicy="strict-origin-when-cross-origin"
              />
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
