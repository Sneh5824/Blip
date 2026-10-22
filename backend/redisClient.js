const { createClient } = require("redis");
const { REDIS_URL } = require("./config");

const client = createClient({
  url: REDIS_URL, // rediss:// enables TLS (required by Upstash)
  socket: {
    // Reconnect forever with capped backoff; commands queue while offline.
    reconnectStrategy: (retries) => Math.min(250 * 2 ** retries, 5000),
    connectTimeout: 10000,
  },
});

let lastErrorLogged = 0;
client.on("ready",        () => console.log("[Redis] Ready"));
client.on("reconnecting", () => console.log("[Redis] Reconnecting..."));
client.on("end",          () => console.log("[Redis] Connection closed"));
client.on("error", (err) => {
  // Error messages never contain the password; throttle to avoid log floods while offline.
  if (Date.now() - lastErrorLogged > 5000) {
    lastErrorLogged = Date.now();
    console.error("[Redis] Error:", err.message);
  }
});

// Resolves once connected; exits if the very first connection never succeeds
// (wrong URL / credentials) so the host restarts us with a visible error.
const whenConnected = client.connect().catch((err) => {
  console.error("[Redis] Failed to connect:", err.message);
  process.exit(1);
});

module.exports = client;
module.exports.whenConnected = whenConnected;
