// ─── Environment configuration ───────────────────────────────────────────────
// Read once at startup. In production, missing required settings stop the
// process with a clear message instead of failing later in confusing ways.
require("dotenv").config();

const env = process.env;
const IS_PRODUCTION = env.NODE_ENV === "production";

const flag = (value, fallback) => {
  if (value === undefined || value === "") return fallback;
  return !["off", "false", "0", "no", "disabled"].includes(String(value).trim().toLowerCase());
};

const DEV_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];

/** FRONTEND_URL may hold several comma-separated origins. */
function parseOrigins(raw) {
  return String(raw || "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

const errors = [];
const warnings = [];

const frontendOrigins = parseOrigins(env.FRONTEND_URL);
for (const origin of frontendOrigins) {
  if (origin === "*") continue;
  try {
    const u = new URL(origin);
    if (u.origin !== origin) errors.push(`FRONTEND_URL entry "${origin}" must be a bare origin like https://app.example.com (no path).`);
    if (IS_PRODUCTION && u.protocol !== "https:" && !DEV_ORIGINS.includes(origin)) {
      warnings.push(`FRONTEND_URL entry "${origin}" is not https.`);
    }
  } catch {
    errors.push(`FRONTEND_URL entry "${origin}" is not a valid URL.`);
  }
}

if (IS_PRODUCTION) {
  if (!env.REDIS_URL) errors.push("REDIS_URL is required in production.");
  if (frontendOrigins.length === 0) errors.push("FRONTEND_URL is required in production (your Vercel URL, e.g. https://blip.vercel.app).");
  if (frontendOrigins.includes("*")) errors.push('FRONTEND_URL="*" is not allowed in production.');
}
if (env.REDIS_URL && !/^rediss?:\/\//.test(env.REDIS_URL)) {
  errors.push("REDIS_URL must start with redis:// or rediss:// (Upstash needs rediss://).");
}
if (env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length < 12) {
  warnings.push("ADMIN_PASSWORD is shorter than 12 characters.");
}

// Development keeps working with zero configuration.
const corsOrigins = frontendOrigins.length
  ? (frontendOrigins.includes("*") ? "*" : [...new Set([...frontendOrigins, ...(IS_PRODUCTION ? [] : DEV_ORIGINS)])])
  : DEV_ORIGINS;

const config = {
  IS_PRODUCTION,
  PORT: Number(env.PORT) || 5001,
  // Render requires 0.0.0.0; locally keep Node's dual-stack default so both
  // 127.0.0.1 and ::1 ("localhost" on newer Node) work.
  HOST: env.HOST || (IS_PRODUCTION ? "0.0.0.0" : undefined),
  REDIS_URL: env.REDIS_URL || "redis://localhost:6379",
  CORS_ORIGINS: corsOrigins,
  ADMIN_PASSWORD: env.ADMIN_PASSWORD || "",
  // Behind Render/other proxies the client IP comes from X-Forwarded-For.
  TRUST_PROXY: env.TRUST_PROXY !== undefined ? Number(env.TRUST_PROXY) || 0 : (IS_PRODUCTION ? 1 : 0),
  // Untrusted code execution is off in production unless explicitly enabled.
  CODE_EXECUTION: flag(env.CODE_EXECUTION, !IS_PRODUCTION),
  ROOM_CREATE_LIMIT_PER_MIN: Number(env.ROOM_CREATE_LIMIT_PER_MIN) || 20,
};

function reportConfig() {
  for (const w of warnings) console.warn(`[Config] Warning: ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`[Config] Error: ${e}`);
    console.error("[Config] Fix the environment variables above and restart.");
    process.exit(1);
  }
  const redisHost = (() => { try { return new URL(config.REDIS_URL).host; } catch { return "?"; } })();
  console.log(`[Config] mode=${IS_PRODUCTION ? "production" : "development"} redis=${redisHost} ` +
    `cors=${Array.isArray(config.CORS_ORIGINS) ? config.CORS_ORIGINS.join(",") : config.CORS_ORIGINS} ` +
    `codeExecution=${config.CODE_EXECUTION ? "on" : "off"} admin=${config.ADMIN_PASSWORD ? "on" : "off"}`);
}

module.exports = { ...config, reportConfig };
