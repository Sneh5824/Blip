const { spawn } = require("child_process");
const fs   = require("fs/promises");
const os   = require("os");
const path = require("path");

// ─── Limits ──────────────────────────────────────────────────────────────────
const RUN_TIMEOUT_MS     = 10000;
const COMPILE_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES   = 64 * 1024;
const MAX_CONCURRENT     = Number(process.env.CODE_EXEC_MAX_CONCURRENT) || 4;
const IS_WIN = process.platform === "win32";

let activeRuns = 0;

class RunnerBusyError extends Error {}

// Child processes get a minimal environment so server secrets
// (ADMIN_PASSWORD, REDIS_URL, ...) are never visible to user code.
const ENV_ALLOWLIST = [
  "PATH", "PATHEXT", "SystemRoot", "windir", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG",
  "GOPATH", "GOROOT", "GOCACHE", "JAVA_HOME", "CARGO_HOME", "RUSTUP_HOME",
];
function childEnv() {
  const env = {};
  for (const k of ENV_ALLOWLIST) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

// Node's permission model sandboxes JS/TS: no file access outside the run
// directory, no child processes, no workers. Flag name differs by version.
const nodeFlags = process.allowedNodeEnvironmentFlags;
const NODE_PERMISSION_FLAG = nodeFlags.has("--permission") ? "--permission"
  : nodeFlags.has("--experimental-permission") ? "--experimental-permission" : null;
const NODE_TS_FLAG = nodeFlags.has("--experimental-transform-types") ? "--experimental-transform-types"
  : nodeFlags.has("--experimental-strip-types") ? "--experimental-strip-types" : null;

function nodeSandboxArgs(dir) {
  return NODE_PERMISSION_FLAG ? [NODE_PERMISSION_FLAG, `--allow-fs-read=${dir}`] : [];
}

function killTree(child) {
  if (!child.pid) return;
  try {
    if (IS_WIN) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
    } else {
      process.kill(-child.pid, "SIGKILL"); // whole process group (spawned detached)
    }
  } catch (_) {
    try { child.kill("SIGKILL"); } catch (_) {}
  }
}

/** Runs one process asynchronously with a timeout and capped output. */
function execStep(cmd, args, { cwd, input = "", timeoutMs = RUN_TIMEOUT_MS, shell = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: childEnv(),
        shell,
        windowsHide: true,
        detached: !IS_WIN,
      });
    } catch (err) {
      resolve({ stdout: "", stderr: err.message, exitCode: -1, timedOut: false, spawnError: err.code || "ESPAWN" });
      return;
    }

    const out = [], err = [];
    let size = 0, truncated = false, timedOut = false, settled = false;

    const collect = (bucket) => (chunk) => {
      if (truncated) return;
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        truncated = true;
        bucket.push(chunk.subarray(0, Math.max(0, chunk.length - (size - MAX_OUTPUT_BYTES))));
        killTree(child);
        return;
      }
      bucket.push(chunk);
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));

    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);

    const finish = (exitCode, spawnError = null, spawnMessage = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let stdout = Buffer.concat(out).toString("utf8");
      let stderr = Buffer.concat(err).toString("utf8") || spawnMessage;
      if (truncated) stdout += "\n[output truncated: limit is 64KB]";
      if (timedOut) {
        stderr = `Execution timed out (${Math.round(timeoutMs / 1000)}s)`;
        exitCode = -1;
      }
      resolve({ stdout, stderr, exitCode, timedOut, spawnError });
    };

    child.on("error", (e) => finish(-1, e.code || "ESPAWN", e.message));
    child.on("close", (code) => finish(code ?? -1));

    child.stdin.on("error", () => {}); // process may exit before reading stdin
    child.stdin.end(input);
  });
}

function notInstalled(tool) {
  return { stdout: "", stderr: `"${tool}" is not installed on the server.`, exitCode: -1 };
}

// Windows' Store alias for python3 exits 9009 instead of failing to spawn.
const isMissing = (r) => r.spawnError === "ENOENT" || (IS_WIN && r.exitCode === 9009);

let pythonCmd = null;
async function runPython(file, opts) {
  const candidates = pythonCmd ? [pythonCmd] : IS_WIN ? ["python", "py", "python3"] : ["python3", "python"];
  for (const cmd of candidates) {
    const r = await execStep(cmd, [file], opts);
    if (isMissing(r)) continue;
    pythonCmd = cmd;
    return r;
  }
  return notInstalled("python");
}

function javaClassName(code) {
  const pub = code.match(/public\s+(?:(?:final|abstract)\s+)*class\s+([A-Za-z_$][\w$]*)/);
  if (pub) return pub[1];
  const any = code.match(/\bclass\s+([A-Za-z_$][\w$]*)/);
  return any ? any[1] : "Solution";
}

/** Compiles (if needed) and runs one program inside its own temp directory. */
async function runInDir(dir, language, code, stdin) {
  const runOpts = { cwd: dir, input: stdin, timeoutMs: RUN_TIMEOUT_MS };
  const compileOpts = { cwd: dir, timeoutMs: COMPILE_TIMEOUT_MS };
  const write = async (name) => {
    const f = path.join(dir, name);
    await fs.writeFile(f, code);
    return f;
  };
  const compileThenRun = async (compileCmd, compileArgs, runCmd, runArgs) => {
    const c = await execStep(compileCmd, compileArgs, compileOpts);
    if (isMissing(c)) return notInstalled(compileCmd);
    if (c.exitCode !== 0) return { stdout: "", stderr: c.stderr || c.stdout, exitCode: c.exitCode };
    return execStep(runCmd, runArgs, runOpts);
  };

  switch (language) {
    case "javascript": {
      const f = await write("main.js");
      return execStep(process.execPath, [...nodeSandboxArgs(dir), f], runOpts);
    }
    case "typescript": {
      const f = await write("main.ts");
      if (NODE_TS_FLAG) {
        return execStep(process.execPath, ["--no-warnings", NODE_TS_FLAG, ...nodeSandboxArgs(dir), f], runOpts);
      }
      const r = await execStep("npx", ["--yes", "ts-node", "--skipProject", `"${f}"`], { ...runOpts, shell: true, timeoutMs: COMPILE_TIMEOUT_MS });
      return isMissing(r) ? notInstalled("ts-node") : r;
    }
    case "python": {
      const f = await write("main.py");
      return runPython(f, runOpts);
    }
    case "java": {
      const cls = javaClassName(code);
      const f = await write(`${cls}.java`);
      return compileThenRun("javac", ["-d", dir, f], "java", ["-cp", dir, cls]);
    }
    case "c++": {
      const f = await write("main.cpp");
      const out = path.join(dir, IS_WIN ? "main.exe" : "main.out");
      return compileThenRun("g++", [f, "-o", out], out, []);
    }
    case "rust": {
      const f = await write("main.rs");
      const out = path.join(dir, IS_WIN ? "main.exe" : "main.out");
      return compileThenRun("rustc", [f, "-o", out], out, []);
    }
    case "go": {
      const f = await write("main.go");
      const r = await execStep("go", ["run", f], { ...runOpts, timeoutMs: COMPILE_TIMEOUT_MS });
      return isMissing(r) ? notInstalled("go") : r;
    }
    default:
      return { stdout: "", stderr: `Language "${language}" is not supported.`, exitCode: -1 };
  }
}

const SUPPORTED_LANGUAGES = ["javascript", "typescript", "python", "java", "c++", "rust", "go"];

async function runCode(language, code, stdin = "") {
  if (activeRuns >= MAX_CONCURRENT) {
    throw new RunnerBusyError("The code runner is busy. Try again in a few seconds.");
  }
  activeRuns++;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "blip-run-"));
  try {
    const r = await runInDir(dir, language, code, stdin);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  } finally {
    activeRuns--;
    fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}

module.exports = { runCode, RunnerBusyError, SUPPORTED_LANGUAGES };
