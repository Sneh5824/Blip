// End-to-end tests: boots the real server against a Redis instance and talks
// to it over HTTP + Socket.IO exactly like the frontend does.
//
//   TEST_REDIS_URL=redis://127.0.0.1:6390 npm test
//
// Tests never flush Redis; they only create their own short-lived rooms.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const { io: ioClient } = require("socket.io-client");
const { createClient } = require("redis");

const REDIS_URL = process.env.TEST_REDIS_URL || "redis://127.0.0.1:6390";
const PORT = Number(process.env.TEST_PORT) || 5098;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = "test-admin-pass";
const HOST_GRACE_MS = 1500;

let server = null;
let redis = null;
const openSockets = new Set();

// ─── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const guest = () => crypto.randomUUID();

function startServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      env: {
        ...process.env,
        PORT: String(PORT),
        REDIS_URL,
        ADMIN_PASSWORD,
        HOST_GRACE_MS: String(HOST_GRACE_MS),
        FRONTEND_URL: "*",
        ROOM_CREATE_LIMIT_PER_MIN: "1000",
        ROOM_ATTACHMENT_BUDGET_MB: "6",
        CODE_FLUSH_MS: "100",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 15000);
    const onData = (d) => {
      log += d;
      if (log.includes("Blip backend running")) {
        clearTimeout(timer);
        resolve(proc);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (code) => { clearTimeout(timer); if (!log.includes("Blip backend running")) reject(new Error(`server exited ${code}:\n${log}`)); });
  });
}

function stopServer(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) return resolve();
    proc.once("exit", () => resolve());
    proc.kill();
  });
}

async function api(method, url, body, headers = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

function connect() {
  const s = ioClient(BASE, { transports: ["websocket"], forceNew: true, reconnection: false });
  openSockets.add(s);
  return new Promise((resolve, reject) => {
    s.once("connect", () => resolve(s));
    s.once("connect_error", reject);
  });
}

function once(socket, event, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeoutMs);
    const handler = (data) => { clearTimeout(t); resolve(data); };
    socket.once(event, handler);
  });
}

/** Resolves true if `event` arrives within ms, false otherwise. */
async function receives(socket, event, ms = 600) {
  try { await once(socket, event, ms); return true; } catch { return false; }
}

async function join(socket, roomId, guestId, displayName = "Tester") {
  const joined = once(socket, "room_joined");
  socket.emit("join_room", { roomId, guestId, displayName });
  return joined;
}

async function createRoom(guestId, opts = {}) {
  const r = await api("POST", "/api/rooms", {
    guestId, displayName: "Host", roomType: "coding", timeout: 10, ...opts,
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

/** Host + member already joined to a fresh coding room. */
async function roomWithTwo(opts) {
  const hostId = guest(), memberId = guest();
  const room = await createRoom(hostId, opts);
  const host = await connect();
  const hostJoin = await join(host, room.roomId, hostId, "Host");
  const member = await connect();
  const memberJoin = await join(member, room.roomId, memberId, "Member");
  return { room, hostId, memberId, host, member, hostJoin, memberJoin };
}

function dataUrlOfSize(bytes, mime = "application/octet-stream") {
  return `data:${mime};base64,${Buffer.alloc(bytes, 7).toString("base64")}`;
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────
before(async () => {
  redis = createClient({ url: REDIS_URL });
  await redis.connect();
  server = await startServer();
});

after(async () => {
  for (const s of openSockets) s.disconnect();
  await stopServer(server);
  await redis.quit();
});

// ─── Identity & authorization ────────────────────────────────────────────────
test("guestIds are never exposed to other clients", async () => {
  const { room, hostId, memberId, memberJoin, host, member } = await roomWithTwo();
  const everything = JSON.stringify(memberJoin);
  assert.ok(!everything.includes(hostId), "host guestId leaked in room_joined");
  assert.ok(!everything.includes(memberId), "member guestId leaked in room_joined");
  assert.equal(memberJoin.room.hostId, undefined);
  assert.ok(memberJoin.room.hostUserId, "hostUserId should be present");
  assert.equal(memberJoin.isHost, false);

  const got = once(host, "receive_message");
  member.emit("send_message", { content: "hi" });
  const msg = await got;
  assert.equal(msg.senderId, memberJoin.selfUserId);
  assert.ok(!JSON.stringify(msg).includes(memberId));

  const meta = await api("GET", `/api/rooms/${room.roomId}`);
  assert.ok(!JSON.stringify(meta.data).includes(hostId));
});

test("a member cannot end the room; the host can", async () => {
  const { room, host, member, hostId } = await roomWithTwo();

  const err = once(member, "action_error");
  member.emit("end_room", { roomId: room.roomId, guestId: hostId }); // spoofed guestId is ignored
  assert.match((await err).message, /Only the host/);
  assert.ok(await redis.exists(`room:${room.roomId}`));

  const expired = once(member, "room_expired");
  host.emit("end_room");
  await expired;
  assert.equal(await redis.exists(`room:${room.roomId}`), 0);
});

test("events from sockets that never joined are ignored", async () => {
  const { room, host } = await roomWithTwo();
  const outsider = await connect();
  outsider.emit("send_message", { roomId: room.roomId, guestId: guest(), displayName: "X", content: "spam" });
  outsider.emit("code_update", { roomId: room.roomId, code: "hacked" });
  outsider.emit("end_room", { roomId: room.roomId });
  assert.equal(await receives(host, "receive_message"), false);
  assert.equal(await redis.get(`code:${room.roomId}`), null);
  assert.ok(await redis.exists(`room:${room.roomId}`));
});

test("clients cannot forge system or problem_link messages", async () => {
  const { host, member } = await roomWithTwo();
  const got = once(host, "receive_message");
  member.emit("send_message", { type: "problem_link", content: "javascript:alert(1)" });
  const msg = await got;
  assert.equal(msg.type, "text");
});

// ─── Host presence ───────────────────────────────────────────────────────────
test("host refresh keeps the room alive (grace period)", async () => {
  const { room, host, member, hostId } = await roomWithTwo();
  const status = once(member, "host_status");
  host.disconnect();
  const s = await status;
  assert.equal(s.connected, false);
  assert.ok(s.graceEndsAt > Date.now());

  await sleep(300);
  const host2 = await connect();
  const back = once(member, "host_status");
  const j = await join(host2, room.roomId, hostId, "Host");
  assert.equal(j.isHost, true);
  assert.equal((await back).connected, true);

  await sleep(HOST_GRACE_MS + 500);
  assert.ok(await redis.exists(`room:${room.roomId}`), "room should survive a host refresh");
});

test("room ends if the host does not come back within the grace period", async () => {
  const { room, host, member } = await roomWithTwo();
  const expired = once(member, "room_expired", HOST_GRACE_MS + 3000);
  host.disconnect();
  const e = await expired;
  assert.match(e.message, /host left/i);
  assert.equal(await redis.exists(`room:${room.roomId}`), 0);
});

test("closing one of two tabs keeps the participant in the room", async () => {
  const { room, member, memberId, host } = await roomWithTwo();
  const tab2 = await connect();
  await join(tab2, room.roomId, memberId, "Member");

  member.disconnect();
  assert.equal(await receives(host, "user_left", 700), false);
  const raw = await redis.hGetAll(`participants:${room.roomId}`);
  assert.ok(raw[memberId], "member should still be listed");

  const left = once(host, "user_left");
  tab2.emit("leave_room");
  await left;
  const after = await redis.hGetAll(`participants:${room.roomId}`);
  assert.equal(after[memberId], undefined);
});

// ─── Attachments & URLs ──────────────────────────────────────────────────────
test("2.5MB attachment is delivered and the sender stays connected", async () => {
  const { host, member } = await roomWithTwo();
  const got = once(host, "receive_message", 10000);
  member.emit("send_message", {
    type: "attachment", content: "",
    attachment: { fileName: "big.bin", mimeType: "application/zip", size: 1, dataUrl: dataUrlOfSize(2.5 * 1024 * 1024) },
  });
  const msg = await got;
  assert.equal(msg.attachment.size, 2.5 * 1024 * 1024, "size is computed server-side");
  assert.equal(msg.attachment.mimeType, "application/octet-stream", "mime comes from the data URL");
  assert.equal(msg.attachment.dataUrl, undefined, "blob is not broadcast inline");
  assert.ok(member.connected);

  // The blob is served over HTTP as a forced download with locked-down headers.
  const res = await fetch(`${BASE}/api/rooms/${msg.roomId}/attachments/${msg.attachment.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  assert.match(res.headers.get("content-disposition"), /^attachment; filename="big.bin"/);
  assert.match(res.headers.get("content-security-policy"), /sandbox/);
  assert.equal((await res.arrayBuffer()).byteLength, 2.5 * 1024 * 1024);

  // History holds metadata only.
  const late = await connect();
  const j = await join(late, msg.roomId, guest());
  const hist = j.messages.find((m) => m.id === msg.id);
  assert.ok(hist.attachment.id && !hist.attachment.dataUrl);
});

test("images are served inline, SVG never is, unknown ids 404", async () => {
  const { host, member } = await roomWithTwo();
  const send = async (fileName, mime) => {
    const got = once(host, "receive_message");
    member.emit("send_message", { type: "attachment", attachment: { fileName, dataUrl: dataUrlOfSize(100, mime) } });
    return (await got);
  };
  const png = await send("a.png", "image/png");
  assert.equal(png.attachment.kind, "image");
  let res = await fetch(`${BASE}/api/rooms/${png.roomId}/attachments/${png.attachment.id}`);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.match(res.headers.get("content-disposition"), /^inline/);

  const svg = await send("x.svg", "image/svg+xml");
  assert.equal(svg.attachment.kind, "file");
  res = await fetch(`${BASE}/api/rooms/${svg.roomId}/attachments/${svg.attachment.id}`);
  assert.equal(res.headers.get("content-type"), "application/octet-stream");

  res = await fetch(`${BASE}/api/rooms/${png.roomId}/attachments/${crypto.randomUUID()}`);
  assert.equal(res.status, 404);
  res = await fetch(`${BASE}/api/rooms/${png.roomId}/attachments/..%2F..%2Fetc`);
  assert.equal(res.status, 404);
});

test("per-room attachment budget is enforced", async () => {
  const { host, member } = await roomWithTwo();
  for (let i = 0; i < 2; i++) {
    const got = once(host, "receive_message", 10000);
    member.emit("send_message", { type: "attachment", attachment: { fileName: `f${i}.bin`, dataUrl: dataUrlOfSize(2.5 * 1024 * 1024) } });
    await got;
  }
  const err = once(member, "action_error", 10000);
  member.emit("send_message", { type: "attachment", attachment: { fileName: "f3.bin", dataUrl: dataUrlOfSize(2.5 * 1024 * 1024) } });
  assert.match((await err).message, /storage is full/);
});

test("ending a room deletes its attachment blobs", async () => {
  const { room, host, member } = await roomWithTwo();
  const got = once(host, "receive_message");
  member.emit("send_message", { type: "attachment", attachment: { fileName: "a.txt", dataUrl: dataUrlOfSize(10, "text/plain") } });
  const msg = await got;
  assert.equal(await redis.exists(`att:${room.roomId}:${msg.attachment.id}`), 1);
  const ended = once(member, "room_expired");
  host.emit("end_room");
  await ended;
  assert.equal(await redis.exists(`att:${room.roomId}:${msg.attachment.id}`), 0);
});

test("attachment over 3MB is rejected without disconnecting", async () => {
  const { host, member } = await roomWithTwo();
  const err = once(member, "action_error", 10000);
  member.emit("send_message", {
    type: "attachment",
    attachment: { fileName: "huge.bin", dataUrl: dataUrlOfSize(3.2 * 1024 * 1024) },
  });
  assert.match((await err).message, /too large/i);
  assert.ok(member.connected);
  assert.equal(await receives(host, "receive_message", 400), false);
});

test("non-data-URL attachments (javascript:) are rejected", async () => {
  const { member } = await roomWithTwo();
  const err = once(member, "action_error");
  member.emit("send_message", {
    type: "attachment",
    attachment: { fileName: "x.html", dataUrl: "javascript:alert(document.cookie)" },
  });
  assert.match((await err).message, /invalid attachment/i);
});

test("voice notes are classified as audio", async () => {
  const { host, member } = await roomWithTwo();
  const got = once(host, "receive_message");
  member.emit("send_message", {
    type: "attachment",
    attachment: { fileName: "voice-note.webm", durationSec: 4, dataUrl: dataUrlOfSize(2000, "audio/webm;codecs=opus") },
  });
  const msg = await got;
  assert.equal(msg.attachment.kind, "audio");
  assert.equal(msg.attachment.durationSec, 4);
});

test("problem links must be http(s) and host-only in private rooms", async () => {
  const { host, member } = await roomWithTwo();

  const bad = once(host, "action_error");
  host.emit("share_problem", { link: "javascript:alert(1)" });
  assert.match((await bad).message, /http/);

  const denied = once(member, "action_error");
  member.emit("share_problem", { link: "https://leetcode.com/problems/two-sum/" });
  assert.match((await denied).message, /Only the host/);

  const shared = once(member, "problem_shared");
  host.emit("share_problem", { link: "https://leetcode.com/problems/two-sum/" });
  assert.equal((await shared).link, "https://leetcode.com/problems/two-sum/");
});

// ─── Reactions, language, rate limits ────────────────────────────────────────
test("concurrent reactions from many users are all counted", async () => {
  const { room, host } = await roomWithTwo();
  const got = once(host, "receive_message");
  host.emit("send_message", { content: "react to me" });
  const msg = await got;

  const users = await Promise.all(Array.from({ length: 12 }, async () => {
    const s = await connect();
    await join(s, room.roomId, guest(), "Fan");
    return s;
  }));
  users.forEach((s) => s.emit("toggle_reaction", { messageId: msg.id, emoji: "🔥" }));

  const deadline = Date.now() + 4000;
  let count = 0;
  while (Date.now() < deadline) {
    const raw = await redis.hGet(`reactions:${room.roomId}`, msg.id);
    count = raw ? JSON.parse(raw)["🔥"].length : 0;
    if (count === 12) break;
    await sleep(100);
  }
  assert.equal(count, 12);

  const rejoin = await join(users[0], room.roomId, guest(), "Late");
  const m = rejoin.messages.find((x) => x.id === msg.id);
  assert.equal(m.reactions["🔥"].length, 12, "reactions merged into history");
});

test("unknown emoji and unknown message ids are ignored", async () => {
  const { room, host } = await roomWithTwo();
  host.emit("toggle_reaction", { messageId: crypto.randomUUID(), emoji: "🔥" });
  host.emit("toggle_reaction", { messageId: "x", emoji: "<script>" });
  await sleep(300);
  assert.equal(Object.keys(await redis.hGetAll(`reactions:${room.roomId}`)).length, 0);
});

test("editor language is synced and persisted", async () => {
  const { room, host, member } = await roomWithTwo();
  const got = once(member, "language_updated");
  host.emit("language_update", { language: "python" });
  assert.equal((await got).language, "python");
  const late = await connect();
  const j = await join(late, room.roomId, guest());
  assert.equal(j.room.language, "python");
});

test("message flood is rate limited", async () => {
  const { member } = await roomWithTwo();
  const err = once(member, "action_error");
  for (let i = 0; i < 20; i++) member.emit("send_message", { content: `spam ${i}` });
  assert.match((await err).message, /too quickly/);
});

// ─── Redis TTL / expiry ──────────────────────────────────────────────────────
test("all room keys carry a TTL matching the room expiry", async () => {
  const { room, host, member } = await roomWithTwo();
  const got = once(host, "receive_message");
  host.emit("send_message", { content: "ttl" });
  const msg = await got;
  host.emit("toggle_reaction", { messageId: msg.id, emoji: "👍" });
  host.emit("code_update", { code: "print(1)" });
  member.emit("send_message", { type: "attachment", attachment: { fileName: "t.txt", dataUrl: dataUrlOfSize(10, "text/plain") } });
  await sleep(500);
  for (const key of ["room", "participants", "messages", "msgids", "reactions", "code", "atts", "attbytes"]) {
    const ttl = await redis.pTTL(`${key}:${room.roomId}`);
    assert.ok(ttl > 9 * 60 * 1000 && ttl <= 10 * 60 * 1000, `${key} ttl=${ttl}`);
  }
});

// ─── Code execution ──────────────────────────────────────────────────────────
test("/api/run requires room membership", async () => {
  const { room, memberId } = await roomWithTwo();
  const anon = await api("POST", "/api/run", { language: "javascript", code: "console.log(1)" });
  assert.equal(anon.status, 403);
  const stranger = await api("POST", "/api/run", { roomId: room.roomId, guestId: guest(), language: "javascript", code: "1" });
  assert.equal(stranger.status, 403);
  const ok = await api("POST", "/api/run", { roomId: room.roomId, guestId: memberId, language: "javascript", code: "console.log(6*7)" });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.run.stdout.trim(), "42");
});

test("chat rooms cannot run code", async () => {
  const hostId = guest();
  const room = await createRoom(hostId, { roomType: "chat" });
  const s = await connect();
  await join(s, room.roomId, hostId);
  const r = await api("POST", "/api/run", { roomId: room.roomId, guestId: hostId, language: "javascript", code: "1" });
  assert.equal(r.status, 403);
});

test("code runs with stdin, without server secrets, and JS cannot read server files", async () => {
  const { room, memberId } = await roomWithTwo();
  const run = (language, code, stdin = "") =>
    api("POST", "/api/run", { roomId: room.roomId, guestId: memberId, language, code, stdin });

  const echo = await run("python", "print(input()[::-1])", "olleh\n");
  assert.equal(echo.data.run.stdout.trim(), "hello", JSON.stringify(echo.data));

  const env = await run("python", "import os; print(os.environ.get('ADMIN_PASSWORD'), os.environ.get('REDIS_URL'))");
  assert.equal(env.data.run.stdout.trim(), "None None");

  const read = await run("javascript", `try { require("fs").readFileSync(${JSON.stringify(path.join(__dirname, "..", "server.js"))}); console.log("READ") } catch (e) { console.log(e.code) }`);
  assert.equal(read.data.run.stdout.trim(), "ERR_ACCESS_DENIED");

  const ts = await run("typescript", "const n: number = 5; enum C { A = 2 } console.log(n * C.A);");
  assert.equal(ts.data.run.stdout.trim(), "10", JSON.stringify(ts.data));
});

test("concurrent Java runs do not collide", async () => {
  const { room, memberId } = await roomWithTwo();
  const prog = (n) => `public class Solution { public static void main(String[] a) { System.out.println(${n}); } }`;
  const [a, b] = await Promise.all([1111, 2222].map((n) =>
    api("POST", "/api/run", { roomId: room.roomId, guestId: memberId, language: "java", code: prog(n) })));
  assert.equal(a.data.run.stdout.trim(), "1111", JSON.stringify(a.data));
  assert.equal(b.data.run.stdout.trim(), "2222", JSON.stringify(b.data));

  const other = await api("POST", "/api/run", { roomId: room.roomId, guestId: memberId, language: "java",
    code: "public class Main { public static void main(String[] a) { System.out.println(\"main\"); } }" });
  assert.equal(other.data.run.stdout.trim(), "main", JSON.stringify(other.data));
});

// Skip when the machine's own C++ toolchain cannot link a trivial program.
function gppWorks() {
  const os = require("os"), fs = require("fs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blip-gpp-"));
  try {
    fs.writeFileSync(path.join(dir, "t.cpp"), "int main(){}");
    return require("child_process").spawnSync("g++", ["t.cpp", "-o", "t.exe"], { cwd: dir }).status === 0;
  } catch { return false; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("C++ compiles and runs", { skip: !gppWorks() && "local g++ toolchain cannot link" }, async () => {
  const { room, memberId } = await roomWithTwo();
  const r = await api("POST", "/api/run", { roomId: room.roomId, guestId: memberId, language: "c++",
    code: "#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b;}", stdin: "2 3" });
  assert.equal(r.data.run.stdout.trim(), "5", JSON.stringify(r.data));
});

test("infinite loop times out and the server stays responsive", async () => {
  const { room, memberId } = await roomWithTwo();
  const started = Date.now();
  const running = api("POST", "/api/run", { roomId: room.roomId, guestId: memberId, language: "javascript", code: "while(true){}" });

  await sleep(500);
  const t0 = Date.now();
  const health = await api("GET", "/health");
  assert.equal(health.status, 200);
  assert.ok(Date.now() - t0 < 500, "health check blocked by code execution");

  const r = await running;
  assert.match(r.data.run.stderr, /timed out/);
  assert.ok(Date.now() - started < 14000);
});

// ─── Public rooms & admin ────────────────────────────────────────────────────
test("public rooms are hostless and listed", async () => {
  const r = await api("GET", "/api/public-rooms");
  const ids = r.data.rooms.map((x) => x.roomId);
  assert.ok(ids.includes("PUB10M") && ids.includes("PUB20M"));
  const s = await connect();
  const j = await join(s, "PUB10M", guest());
  assert.equal(j.isHost, false);
  assert.equal(j.room.hostUserId, null);
});

test("admin: auth, create/duplicate/delete public rooms, stats", async () => {
  const bad = await api("POST", "/api/admin/login", { password: "nope" });
  assert.equal(bad.status, 401);
  const login = await api("POST", "/api/admin/login", { password: ADMIN_PASSWORD });
  assert.equal(login.status, 200);
  const auth = { Authorization: `Bearer ${login.data.token}` };

  assert.equal((await api("GET", "/api/admin/stats")).status, 401);

  const id = `T${crypto.randomInt(100000, 999999)}`;
  const created = await api("POST", "/api/admin/public-rooms", { timeout: 10, roomName: "Admin Room", roomId: id }, auth);
  assert.equal(created.status, 201, JSON.stringify(created.data));

  const dup = await api("POST", "/api/admin/public-rooms", { timeout: 10, roomId: id }, auth);
  assert.equal(dup.status, 409);
  const sys = await api("POST", "/api/admin/public-rooms", { timeout: 10, roomId: "PUB10M" }, auth);
  assert.equal(sys.status, 409, "must not overwrite a system room");

  const listed = await api("GET", "/api/public-rooms");
  assert.ok(listed.data.rooms.some((x) => x.roomId === id), "admin-created room visible to users");

  const stats = await api("GET", "/api/admin/stats", undefined, auth);
  assert.equal(stats.status, 200);
  assert.ok(stats.data.activeRooms >= 3);

  const del = await api("DELETE", `/api/admin/public-rooms/${id}`, undefined, auth);
  assert.equal(del.status, 200);
  assert.equal(await redis.exists(`room:${id}`), 0);

  const delSys = await api("DELETE", "/api/admin/public-rooms/PUB20M", undefined, auth);
  assert.equal(delSys.data.recreated, true);
  assert.ok(await redis.exists("room:PUB20M"), "system room comes back");
});

// ─── Restart recovery (restarts the server) ──────────────────────────────────
test("after a restart, room timers are restored and stale participants cleared", async () => {
  const hostId = guest();
  const room = await createRoom(hostId);
  const s = await connect();
  await join(s, room.roomId, hostId);
  s.disconnect();

  // A room that should expire 2.5s after the restart.
  const shortId = `R${crypto.randomInt(100000, 999999)}`;
  const expiresAt = Date.now() + 4000;
  await redis.set(`room:${shortId}`, JSON.stringify({
    roomId: shortId, hostId: null, roomType: "chat", timeout: 10, visibility: "private",
    roomName: "short", createdAt: Date.now(), expiresAt, status: "active", problemLink: null,
  }), { PX: 60000 }); // deliberately longer TTL: the restored timer must delete it
  await redis.zAdd("rooms:expiry", { score: expiresAt, value: shortId });
  await redis.hSet(`participants:${shortId}`, "ghost", JSON.stringify({ userId: "g", displayName: "Ghost", joinedAt: 1 }));

  await stopServer(server);
  server = await startServer();

  assert.equal(await redis.exists(`participants:${shortId}`), 0, "stale participants cleared");

  // The host's client reconnects automatically after a restart (within the grace period).
  const hostAgain = await connect();
  assert.equal((await join(hostAgain, room.roomId, hostId)).isHost, true);

  const watcher = await connect();
  await join(watcher, shortId, guest());
  const expired = await once(watcher, "room_expired", 6000);
  assert.ok(expired.message);
  assert.equal(await redis.exists(`room:${shortId}`), 0);
  assert.ok(await redis.exists(`room:${room.roomId}`), "unexpired room still exists after restart");
});

// ─── Production mode (separate server instance) ──────────────────────────────
const PROD_PORT = PORT - 1;
const PROD_BASE = `http://127.0.0.1:${PROD_PORT}`;
const PROD_ORIGIN = "https://blip-test.vercel.app";

function runServer(env) {
  return spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, REDIS_URL, PORT: String(PROD_PORT), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("production refuses to start without FRONTEND_URL", async () => {
  const proc = runServer({ NODE_ENV: "production", FRONTEND_URL: "" });
  let log = "";
  proc.stdout.on("data", (d) => { log += d; });
  proc.stderr.on("data", (d) => { log += d; });
  const code = await new Promise((r) => proc.on("exit", r));
  assert.equal(code, 1);
  assert.match(log, /FRONTEND_URL is required in production/);
  assert.ok(!log.includes("@"), "no credentials in logs");
});

test("production: strict CORS, code execution off, proxy-aware rate limits", async () => {
  const proc = runServer({
    NODE_ENV: "production", FRONTEND_URL: PROD_ORIGIN, ADMIN_PASSWORD: "prod-test-password",
    CODE_EXECUTION: "", HOST_GRACE_MS: "1500",
  });
  try {
    await new Promise((resolve, reject) => {
      let log = "";
      const t = setTimeout(() => reject(new Error("prod server did not start\n" + log)), 15000);
      const on = (d) => { log += d; if (log.includes("Blip backend running")) { clearTimeout(t); resolve(); } };
      proc.stdout.on("data", on); proc.stderr.on("data", on);
    });

    const health = await (await fetch(`${PROD_BASE}/health`)).json();
    assert.equal(health.redis, "ready");

    const ok = await fetch(`${PROD_BASE}/api/public-rooms`, { headers: { Origin: PROD_ORIGIN } });
    assert.equal(ok.headers.get("access-control-allow-origin"), PROD_ORIGIN);
    const evil = await fetch(`${PROD_BASE}/api/public-rooms`, { headers: { Origin: "https://evil.example" } });
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
    const dev = await fetch(`${PROD_BASE}/api/public-rooms`, { headers: { Origin: "http://localhost:3000" } });
    assert.equal(dev.headers.get("access-control-allow-origin"), null, "dev origins not allowed in production");

    // Code execution is off by default in production, and clients are told so.
    const hostId = guest();
    const created = await fetch(`${PROD_BASE}/api/rooms`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ guestId: hostId, displayName: "H", roomType: "coding", timeout: 10 }),
    });
    const room = await created.json();
    const s = ioClient(PROD_BASE, { transports: ["websocket"], forceNew: true, reconnection: false, extraHeaders: { Origin: PROD_ORIGIN } });
    openSockets.add(s);
    await new Promise((r) => s.once("connect", r));
    const j = await join(s, room.roomId, hostId);
    assert.equal(j.features.codeExecution, false);
    const run = await fetch(`${PROD_BASE}/api/run`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: room.roomId, guestId: hostId, language: "javascript", code: "1" }),
    });
    assert.equal(run.status, 503);
    s.emit("end_room");

    // Behind a proxy, each client IP gets its own limiter bucket.
    const login = (ip) => fetch(`${PROD_BASE}/api/admin/login`, {
      method: "POST", headers: { "content-type": "application/json", "X-Forwarded-For": ip },
      body: JSON.stringify({ password: "wrong" }),
    });
    let last;
    for (let i = 0; i < 11; i++) last = await login("203.0.113.7");
    assert.equal(last.status, 429);
    assert.equal((await login("198.51.100.9")).status, 401, "another IP is not throttled");
  } finally {
    await stopServer(proc);
  }
});

test("admin login is rate limited", async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await api("POST", "/api/admin/login", { password: "wrong" });
  assert.equal(last.status, 429);
});
