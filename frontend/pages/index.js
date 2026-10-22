import { useState, useEffect, useRef, useCallback } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import { getOrCreateIdentity } from "../lib/identity";

const BACKEND  = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:5001";

const TIMEOUTS = [10, 20, 30, 60];

const POSTER_LINES = [
  { text: "TIMED.",      cls: "text-white",         delay: 0.10 },
  { text: "ANONYMOUS.",  cls: "text-white/70",      delay: 0.38 },
  { text: "GONE",        cls: "text-red-500",       delay: 0.78 },
  { text: "IN A",        cls: "text-white/40",      delay: 1.08 },
  { text: "BLIP.",       cls: "text-amber-400",     delay: 1.32 },
];



export default function Home() {
  const router  = useRouter();
  const autoJoinDoneRef = useRef(false);
  const [identity, setIdentity]   = useState(null);
  const [roomType, setRoomType]   = useState("coding");
  const [timeout,  setTimeoutVal] = useState(30);
  const [roomName, setRoomName]   = useState("");
  const [creating, setCreating]   = useState(false);
  const [createErr, setCreateErr] = useState("");

  const [joinId,   setJoinId]   = useState("");
  const [joining,  setJoining]  = useState(false);
  const [joinErr,  setJoinErr]  = useState("");
  const [tab,      setTab]      = useState("create");
  const [publicRooms, setPublicRooms] = useState([]);
  const [publicLoading, setPublicLoading] = useState(false);
  const [publicErr, setPublicErr] = useState("");

  useEffect(() => {
    setIdentity(getOrCreateIdentity());
  }, []);

  /* ── Create room ───────────────────────────────────────────────────────── */
  const handleCreate = async () => {
    if (!identity || creating) return;
    setCreating(true);
    setCreateErr("");
    try {
      const res = await fetch(`${BACKEND}/api/rooms`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          guestId:     identity.guestId,
          displayName: identity.displayName,
          roomType,
          timeout,
          roomName:    roomName.trim() || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create room.");
      }
      const room = await res.json();
      router.push(`/room/${room.roomId}`);
    } catch (err) {
      setCreateErr(err.message);
    } finally {
      setCreating(false);
    }
  };

  /* ── Join room ─────────────────────────────────────────────────────────── */
  const handleJoinById = useCallback(async (rawRoomId) => {
    const rid = (rawRoomId || "").trim().toUpperCase();
    if (!rid || joining) return;
    setJoining(true);
    setJoinErr("");
    try {
      const res = await fetch(`${BACKEND}/api/rooms/${rid}`);
      if (!res.ok) {
        setJoinErr("Room not found or has already expired.");
        return;
      }
      router.push(`/room/${rid}`);
    } catch {
      setJoinErr("Unable to reach server.");
    } finally {
      setJoining(false);
    }
  }, [joining, router]);

  const handleJoin = async () => {
    await handleJoinById(joinId);
  };

  const loadPublicRooms = useCallback(async () => {
    setPublicLoading(true);
    setPublicErr("");
    try {
      const res = await fetch(`${BACKEND}/api/public-rooms`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to load public rooms.");
      }
      const data = await res.json();
      setPublicRooms(Array.isArray(data.rooms) ? data.rooms : []);
    } catch (err) {
      setPublicErr(err.message || "Unable to load public rooms.");
    } finally {
      setPublicLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab !== "public") return;
    loadPublicRooms();
    const timer = setInterval(loadPublicRooms, 15000);
    return () => clearInterval(timer);
  }, [tab, loadPublicRooms]);

  const formatRemaining = (expiresAt) => {
    const ms = Number(expiresAt || 0) - Date.now();
    if (ms <= 0) return "expiring";
    const min = Math.ceil(ms / 60000);
    return `${min}m left`;
  };

  useEffect(() => {
    if (!router.isReady || !identity || autoJoinDoneRef.current) return;

    const rawInvite = typeof router.query.invite === "string" ? router.query.invite : "";
    if (!rawInvite) return;

    const normalized = rawInvite.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(normalized)) return;

    autoJoinDoneRef.current = true;
    setTab("join");
    setJoinId(normalized);

    const mode = typeof router.query.mode === "string" ? router.query.mode.toLowerCase() : "";
    if (mode === "chat" || mode === "coding") setRoomType(mode);

    handleJoinById(normalized);
  }, [router.isReady, router.query, identity, handleJoinById]);

  return (
    <>
      <Head>
        <title>Blip — Timed Anonymous Collaboration</title>
        <meta name="description" content="Blip — Snap into a timed anonymous collaborative coding room. No accounts. No traces." />
      </Head>

      <div className="min-h-screen bg-[#07070e] flex flex-col lg:flex-row overflow-hidden">

        {/* LEFT — Poster Hero */}
        <div className="relative flex-1 flex flex-col justify-between px-5 sm:px-8 lg:px-10 py-8 sm:py-10 lg:py-12 overflow-hidden select-none min-h-[48vh] lg:min-h-screen">

          <div className="film-grain" />
          <div className="scan-line" />
          <div className="absolute top-0 left-0 w-80 h-80 bg-red-800/10 rounded-full blur-[80px] pointer-events-none" />
          <div className="absolute bottom-10 right-0 w-60 h-60 rounded-full blur-[60px] pointer-events-none" style={{ background: "rgba(161,98,7,0.06)" }} />
          <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(ellipse at bottom left,rgba(220,38,38,0.05) 0%,transparent 65%)" }} />
          <div className="panel-line" style={{ left: "36%" }} />
          <div className="panel-line panel-line-2" style={{ left: "67%" }} />

          <div className="relative z-10 flex items-center gap-3 animate-fade-in">
            <span className="w-10 h-10 rounded-md flex items-center justify-center text-white font-black text-xl" style={{ background: "linear-gradient(135deg,#dc2626 0%,#7f1d1d 100%)", boxShadow: "0 0 24px rgba(220,38,38,0.4)", fontFamily: "'Bebas Neue','Barlow Condensed',sans-serif" }}>B</span>
            <span className="text-white text-xl tracking-[0.3em]" style={{ fontFamily: "'Bebas Neue','Barlow Condensed',sans-serif" }}>BLIP</span>
            <span className="text-[10px] font-mono text-red-600/70 border border-red-900/40 px-1.5 py-0.5 rounded tracking-widest">BETA</span>
          </div>

          {/* Giant poster words */}
          <div className="relative z-10 py-6">
            <div className="flex flex-col gap-0 mb-6">
              {POSTER_LINES.map(({ text, cls, delay }) => (
                <div key={text} className="poster-line" style={{ lineHeight: 0.88 }}>
                  {text.split("").map((ch, ci) => (
                    <span
                      key={ci}
                      className={`poster-char ${cls}`}
                      style={{ animationDelay: `${delay + ci * 0.048}s` }}
                    >
                      {ch === " " ? "\u00A0" : ch}
                    </span>
                  ))}
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2">
              {Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="snap-dot" style={{ animationDelay: `${1.65 + i * 0.06}s` }} />
              ))}
              <span className="ml-2 text-[11px] uppercase tracking-[0.28em]" style={{ color: "rgba(255,255,255,0.2)", fontFamily: "'Bebas Neue','Barlow Condensed',sans-serif", opacity: 0, animation: "fadeIn 0.5s 2.3s both" }}>
                snap. code. vanish.
              </span>
            </div>
          </div>

          {/* Identity + tags */}
          <div className="relative z-10">
            {identity && (
              <div className="flex items-center gap-3 mb-5" style={{ opacity: 0, animation: "fadeIn 0.6s 1.3s both" }}>
                <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-red-300 flex-shrink-0" style={{ background: "rgba(220,38,38,0.14)", border: "1px solid rgba(220,38,38,0.28)" }}>
                  {identity.displayName?.[0]}
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.2em]" style={{ color: "rgba(255,255,255,0.28)" }}>Identity assigned</p>
                  <p className="text-sm font-semibold" style={{ color: "rgba(255,255,255,0.75)" }}>{identity.displayName}</p>
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-x-6 gap-y-1.5" style={{ opacity: 0, animation: "fadeIn 0.6s 1.5s both" }}>
              {["No Login", "Auto-Expires", "Real-Time", "Zero Trace"].map((f) => (
                <div key={f} className="flex items-center gap-1.5">
                  <div className="w-1 h-1 rounded-full" style={{ background: "rgba(220,38,38,0.6)" }} />
                  <span className="text-[11px] uppercase tracking-widest" style={{ color: "rgba(255,255,255,0.28)" }}>{f}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* RIGHT — Action Panel */}
        <div className="w-full lg:w-[420px] flex flex-col min-h-[52vh] lg:min-h-screen" style={{ background: "linear-gradient(180deg,#0e0e1c 0%,#0a0a14 100%)", borderLeft: "1px solid rgba(255,255,255,0.045)" }}>

          <div className="flex flex-shrink-0" style={{ borderBottom: "1px solid rgba(255,255,255,0.055)" }}>
            {[{ id: "create", label: "Create Room" }, { id: "join", label: "Join Room" }, { id: "public", label: "Public Rooms" }].map(({ id, label }) => (
              <button key={id} onClick={() => setTab(id)} className="flex-1 relative py-3.5 sm:py-4 px-1 text-[10px] sm:text-xs font-semibold uppercase tracking-[0.12em] sm:tracking-[0.18em] transition-colors duration-200" style={{ color: tab === id ? "#fff" : "rgba(255,255,255,0.22)" }}>
                {label}
                {tab === id && <span className="tab-bar" />}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-4 sm:p-7 flex flex-col gap-5 sm:gap-6">

            {tab === "create" && (
              <>
                <Field label="Room Name" hint="optional">
                  <input type="text" value={roomName} onChange={(e) => setRoomName(e.target.value.slice(0, 40))} placeholder="e.g. Weekly DSA Grind, Bug Hunt 3am…" className="blip-input" maxLength={40} />
                  {roomName && <p className="text-right text-[11px] mt-1" style={{ color: "rgba(255,255,255,0.18)" }}>{roomName.trim().length}/40</p>}
                </Field>
                <Field label="Type">
                  <div className="grid grid-cols-2 gap-2">
                    {[{ v: "chat", l: "Chat Only" }, { v: "coding", l: "Coding" }].map(({ v, l }) => (
                      <button key={v} onClick={() => setRoomType(v)} className={`blip-type-btn ${roomType === v ? "active" : ""}`}>{l}</button>
                    ))}
                  </div>
                </Field>
                <Field label="Duration">
                  <div className="flex gap-2 flex-wrap">
                    {TIMEOUTS.map((t) => (
                      <button key={t} onClick={() => setTimeoutVal(t)} className={`blip-pill ${timeout === t ? "active" : ""}`}>{t}m</button>
                    ))}
                  </div>
                </Field>
                {createErr && <Err>{createErr}</Err>}
                <button onClick={handleCreate} disabled={creating || !identity} className="blip-btn-red mt-auto">
                  {creating ? <><Spinner /> Creating…</> : "+ Create Room"}
                </button>
              </>
            )}

            {tab === "join" && (
              <>
                <Field label="Room ID">
                  <input className="blip-input font-mono text-lg sm:text-xl tracking-[0.18em] sm:tracking-[0.3em] uppercase text-center" placeholder="AB3Z9K" maxLength={6} value={joinId} onChange={(e) => { setJoinId(e.target.value.toUpperCase()); setJoinErr(""); }} onKeyDown={(e) => e.key === "Enter" && handleJoin()} autoComplete="off" spellCheck={false} />
                </Field>
                {joinErr && <Err>{joinErr}</Err>}
                <button onClick={handleJoin} disabled={joining || !joinId.trim() || !identity} className="blip-btn-gold">
                  {joining ? <><Spinner /> Joining…</> : "→  Enter Room"}
                </button>
                {identity && (
                  <div className="mt-2 pt-5" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                    <p className="text-[10px] uppercase tracking-[0.2em] mb-3" style={{ color: "rgba(255,255,255,0.22)" }}>Entering as</p>
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-amber-300 flex-shrink-0" style={{ background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.25)" }}>
                        {identity.displayName?.[0]}
                      </div>
                      <div>
                        <p className="text-sm font-semibold" style={{ color: "rgba(255,255,255,0.78)" }}>{identity.displayName}</p>
                        <p className="text-[11px] font-mono" style={{ color: "rgba(255,255,255,0.2)" }}>{identity.guestId.slice(0, 8)}…</p>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}

            {tab === "public" && (
              <>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] uppercase tracking-[0.2em]" style={{ color: "rgba(255,255,255,0.3)" }}>
                    Open Rooms
                  </p>
                  <button onClick={loadPublicRooms} className="text-xs px-2 py-1 rounded" style={{ background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.72)" }}>
                    Refresh
                  </button>
                </div>

                {publicErr && <Err>{publicErr}</Err>}

                {publicLoading ? (
                  <p className="text-sm" style={{ color: "rgba(255,255,255,0.35)" }}>Loading public rooms…</p>
                ) : publicRooms.length === 0 ? (
                  <p className="text-sm" style={{ color: "rgba(255,255,255,0.35)" }}>No active public rooms right now.</p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {publicRooms.map((room) => (
                      <div
                        key={room.roomId}
                        className="px-3 py-3 rounded-xl"
                        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}
                      >
                        <div className="flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold truncate" style={{ color: "rgba(255,255,255,0.85)" }}>{room.roomName || "Public Chat"}</p>
                            <p className="text-[11px] mt-0.5" style={{ color: "rgba(255,255,255,0.38)" }}>
                              {room.participantCount} online · {formatRemaining(room.expiresAt)}
                            </p>
                          </div>
                          <button
                            onClick={() => handleJoinById(room.roomId)}
                            disabled={joining || !identity}
                            className="w-full sm:w-auto px-2.5 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider disabled:opacity-50"
                            style={{ background: "rgba(220,38,38,0.18)", color: "#fecaca", border: "1px solid rgba(220,38,38,0.35)" }}
                          >
                            Join
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <p className="text-xs mt-auto" style={{ color: "rgba(255,255,255,0.26)" }}>
                  Anyone can join these rooms without invitation code. Rooms auto-delete when timer ends.
                </p>
              </>
            )}
          </div>

          <div className="flex-shrink-0 flex items-center justify-between px-4 sm:px-7 py-3" style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
            <span className="text-[10px] uppercase tracking-[0.2em]" style={{ color: "rgba(255,255,255,0.14)" }}>No data. No trace.</span>
            <span className="text-[10px] tracking-[0.25em]" style={{ color: "rgba(255,255,255,0.14)", fontFamily: "'Bebas Neue','Barlow Condensed',sans-serif" }}>BLIP</span>
          </div>
        </div>

      </div>
    </>
  );
}

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="flex items-baseline gap-2 mb-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.2em]" style={{ color: "rgba(255,255,255,0.28)" }}>{label}</span>
        {hint && <span className="text-[10px]" style={{ color: "rgba(255,255,255,0.14)" }}>{hint}</span>}
      </label>
      {children}
    </div>
  );
}

function Err({ children }) {
  return (
    <p className="text-sm px-3 py-2 rounded-lg" style={{ color: "#fca5a5", background: "rgba(220,38,38,0.08)", border: "1px solid rgba(220,38,38,0.25)" }}>
      {children}
    </p>
  );
}

function Spinner() {
  return (
    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  );
}
