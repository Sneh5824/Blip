// ─── Fixed-window rate limiter (in-memory, single process) ───────────────────
function createLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> { count, resetAt }

  // Drop stale windows so the map does not grow forever.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, Math.max(windowMs, 10000));
  sweep.unref();

  /** Records a hit for `key`; returns false once the limit is exceeded. */
  return function allow(key) {
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    return entry.count <= max;
  };
}

/** Express middleware wrapper keyed by client IP. */
function limitByIp(opts, message = "Too many requests. Please slow down.") {
  const allow = createLimiter(opts);
  return (req, res, next) => {
    if (allow(req.ip)) return next();
    res.status(429).json({ error: message });
  };
}

module.exports = { createLimiter, limitByIp };
