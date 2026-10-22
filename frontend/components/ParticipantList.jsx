function getInitial(name) {
  return name ? name[0].toUpperCase() : "?";
}

export default function ParticipantList({ participants = [], hostUserId, currentUserId, collapsed, onToggleCollapse }) {
  if (collapsed) {
    return (
      <div className="flex flex-col h-full items-center pt-3 gap-2">
        <button
          onClick={onToggleCollapse}
          title={`Expand participants (${participants.length})`}
          className="w-7 h-7 rounded-md flex items-center justify-center transition-colors"
          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)", color: "rgba(255,255,255,0.3)" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "rgba(220,38,38,0.85)"; e.currentTarget.style.borderColor = "rgba(220,38,38,0.3)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(255,255,255,0.3)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.07)"; }}
        >
          {/* Chevron right */}
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {/* Participant count pill */}
        <span
          className="text-[9px] font-bold"
          style={{ color: "rgba(255,255,255,0.18)", writingMode: "vertical-rl", letterSpacing: "0.1em" }}
        >
          {participants.length} {participants.length === 1 ? "USER" : "USERS"}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: "1px solid rgba(255,255,255,0.055)" }}>
        <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: "rgba(255,255,255,0.22)" }}>
          Participants ({participants.length})
        </p>
        <button
          onClick={onToggleCollapse}
          title="Collapse panel"
          className="w-5 h-5 rounded flex items-center justify-center transition-colors flex-shrink-0"
          style={{ color: "rgba(255,255,255,0.2)" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "rgba(220,38,38,0.7)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(255,255,255,0.2)"; }}
        >
          {/* Chevron left */}
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M7.5 2.5L4 6l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {participants.length === 0 ? (
          <p className="text-xs italic px-4 py-3" style={{ color: "rgba(255,255,255,0.2)" }}>No participants yet…</p>
        ) : (
          participants.map((p) => (
            <div
              key={p.userId}
              className="flex items-center gap-2.5 px-4 py-2 transition-colors"
              style={p.userId === currentUserId ? { background: "rgba(220,38,38,0.06)" } : undefined}
              onMouseEnter={(e) => { if (p.userId !== currentUserId) e.currentTarget.style.background = "rgba(255,255,255,0.035)"; }}
              onMouseLeave={(e) => { if (p.userId !== currentUserId) e.currentTarget.style.background = ""; }}
            >
              <div className="relative flex-shrink-0">
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold" style={{ background: "rgba(220,38,38,0.1)", border: "1px solid rgba(220,38,38,0.2)", color: "rgba(255,255,255,0.6)" }}>
                    {getInitial(p.displayName)}
                  </div>
                  <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-emerald-500 rounded-full" style={{ border: "2px solid #07070e" }} />
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium truncate ${
                  p.userId === currentUserId ? "text-red-400" : ""
                }`}
                style={p.userId !== currentUserId ? { color: "rgba(255,255,255,0.65)" } : {}}>
                  {p.displayName}
                  {p.userId === currentUserId && <span className="font-normal" style={{ color: "rgba(255,255,255,0.3)" }}> (you)</span>}
                </p>
              </div>
              {p.userId === hostUserId && (
                <span className="flex-shrink-0 text-[10px] font-semibold uppercase tracking-wide" style={{ color: "#fcd34d" }} title="Host">Host</span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
