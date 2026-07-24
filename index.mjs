#!/usr/bin/env node
// laguna-wire-mcp — expose Laguna S 2.1 (via the poolside `pool` CLI) to Claude Code as a delegate.
// Fifth-family sibling of kimi-wire / glm-wire / qwen-wire; tool surface mirrors them:
//   laguna_implement_plan / laguna_reply / laguna_cancel / laguna_status
//
// Backend per call (one-shot, non-interactive):
//   pool exec -p "<prompt>" -o json --unsafe-auto-allow -d <cwd>
//   laguna_reply adds --continue <run-id> (resume the prior pool conversation for that cwd).
//
// Notes vs the other wire servers:
//   * `pool` authenticates itself (~/.config/poolside/credentials.json). No API key flows through
//     this wrapper and no secret appears on the child's stdout → NO scrub/no-leak layer needed
//     (unlike glm/qwen). That whole INV2/INV8 machinery is intentionally absent.
//   * `pool exec` has NO --model flag. The model is pool's saved account default; verified to be
//     `poolside/laguna-s-2.1`. LAGUNA_WIRE_MODEL here is informational only (shown in the report +
//     an allowlist sanity check); it is NOT passed to pool. Pin it via pool's `/model` if it drifts.
//   * `-o json` is NLJSON: final agent text = lines where {"type":"assistantMessage","message":...};
//     tool calls = {"type":"toolCall",...} / {"type":"toolCallResult",...}.
//   * Exit codes: 0 = task success, 4 = pool ran but could not complete (reported "incomplete"),
//     anything else = unexpected error.
//
// DESIGN: invariant-guards-first. Every entry validates a FIXED set of invariants at runtime
// (`invariant()`, not `assert` — survives `node -O`) BEFORE doing work; guards re-checked per call;
// guards self-tested at boot (fail-closed).
//
// Invariants:
//   INV1 backend binary (`pool`) resolvable                       (re-checked per call)
//   INV3 cwd absolute, exists, is dir, contained in ALLOW_ROOT    <- security boundary for a YOLO agent
//   INV4 model id matches allowlist regex (informational sanity)
//   INV5 prompt non-empty and under length cap
//   INV6 timeout always set+clamped; primary kill + watchdog SIGKILL (guard-on-guard)
//   INV7 output captured with size cap; NLJSON parsed best-effort but raw always retained
//   INV9 single-flight per cwd (no concurrent runs clobbering the same tree)

import { spawn, execFileSync } from "node:child_process";
import { existsSync, statSync, realpathSync, readdirSync, readFileSync } from "node:fs";
import { resolve, sep, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// ---------- config (env-overridable) ----------
const BACKEND_BIN   = process.env.LAGUNA_WIRE_BIN   ?? "pool";
const MODEL         = process.env.LAGUNA_WIRE_MODEL ?? "poolside/laguna-s-2.1"; // informational (pool exec has no --model)
const ALLOW_ROOT    = realpathAbs(process.env.LAGUNA_WIRE_ALLOW_ROOT ?? homedir());
const MODEL_RE      = new RegExp(process.env.LAGUNA_WIRE_MODEL_RE ?? "^poolside/");
const SESSIONS_DIR  = process.env.LAGUNA_WIRE_SESSIONS_DIR
  ?? join(homedir(), "Library", "Application Support", "poolside", "sessions");
const TIMEOUT_MIN_S = 30;
const TIMEOUT_MAX_S = 3600;
const TIMEOUT_DEF_S = 1800;
const PROMPT_MAX    = 200_000;   // chars; -p is a CLI arg (bounded by ARG_MAX). ponytail: pipe via `-p -` stdin if this bites.
const OUTPUT_CAP    = 2_000_000; // bytes of captured stdout+stderr retained

function realpathAbs(p){ try { return realpathSync(resolve(p)); } catch { return resolve(p); } }

// ---------- backend binary resolution (INV1) ----------
// A GUI/stdio-launched MCP server often inherits a minimal PATH (no /opt/homebrew/bin, no ~/.local/bin),
// so a PATH-only lookup fails even when `pool` IS installed. Resolve to an absolute path from
// PATH ∪ common install dirs (fs-only — no bash), and hand the child a PATH that includes those dirs
// too (pool shells out to git etc).
const EXTRA_BIN_DIRS = [
  `${homedir()}/.local/bin`, "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin",
];
function childPath(){
  const cur = (process.env.PATH ?? "").split(":").filter(Boolean);
  return [...new Set([...EXTRA_BIN_DIRS, ...cur, "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
}
function resolveBackend(){
  if (BACKEND_BIN.includes("/")) return existsSync(BACKEND_BIN) ? BACKEND_BIN : null;  // explicit path
  for (const dir of childPath().split(":")) {
    const cand = `${dir}/${BACKEND_BIN}`;
    if (existsSync(cand)) return cand;
  }
  return null;
}
let RESOLVED_BIN = BACKEND_BIN;   // set by guardBinary() to the resolved absolute path

// ---------- guard primitive (always-on; survives `node -O`) ----------
class GuardError extends Error { constructor(m){ super(m); this.name = "GuardError"; } }
function invariant(cond, msg){ if (!cond) throw new GuardError(msg); }

// ---------- pure helpers (self-testable without fs/env) ----------
function isContained(real){ return real === ALLOW_ROOT || real.startsWith(ALLOW_ROOT + sep); }
function clampTimeout(s){
  const n = Number.isFinite(s) ? Math.floor(s) : TIMEOUT_DEF_S;
  return Math.min(TIMEOUT_MAX_S, Math.max(TIMEOUT_MIN_S, n));
}

// ---------- per-input guards ----------
function guardBinary(){                       // INV1 — resolve to an absolute path (fs-only)
  const resolved = resolveBackend();
  invariant(resolved, `backend binary '${BACKEND_BIN}' not found (searched PATH + ${EXTRA_BIN_DIRS.join(", ")}; set LAGUNA_WIRE_BIN to an absolute path)`);
  RESOLVED_BIN = resolved;
}
function guardModel(){                         // INV4 (informational sanity — not passed to pool)
  invariant(MODEL_RE.test(MODEL), `model '${MODEL}' rejected by allowlist ${MODEL_RE}`);
}
function guardPrompt(p){                        // INV5
  invariant(typeof p === "string" && p.trim().length > 0, "prompt/user_input must be a non-empty string");
  invariant(p.length <= PROMPT_MAX, `prompt too long (${p.length} > ${PROMPT_MAX} chars) — split it, or pipe via stdin`);
}
function guardCwd(cwd){                          // INV3 — security boundary
  invariant(typeof cwd === "string" && cwd.length > 0, "cwd is required");
  invariant(cwd.startsWith("/"), "cwd must be an absolute path");
  invariant(existsSync(cwd), `cwd does not exist: ${cwd}`);
  invariant(statSync(cwd).isDirectory(), `cwd is not a directory: ${cwd}`);
  const real = realpathAbs(cwd);
  invariant(real !== "/", "cwd must not be the filesystem root");
  invariant(isContained(real),
    `cwd ${real} is outside the allowed root ${ALLOW_ROOT} (widen with LAGUNA_WIRE_ALLOW_ROOT)`);
  return real;
}

// ---------- single-flight registry (INV9) + per-cwd run-id ----------
const inflight  = new Map();   // realCwd -> { child, startedAt }
const lastRunId = new Map();   // realCwd -> run_id of the most recent completed turn (for --continue)

// ---------- best-effort output parsing (INV7) ----------
function gitChanges(cwd){
  try {
    const o = execFileSync("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8", env: { ...process.env, PATH: childPath() } });
    return o.split("\n").map(l => l.trim()).filter(Boolean);
  } catch { return []; }   // non-git cwd → empty (reported as "none detected")
}
function extractFinal(stdout){
  // pool `-o json` is NLJSON. Final agent text = concatenation of assistantMessage lines.
  const parts = [];
  for (const l of stdout.split("\n")) {
    const s = l.trim();
    if (!s.startsWith("{")) continue;
    try {
      const e = JSON.parse(s);
      if (e.type === "assistantMessage" && typeof e.message === "string" && e.message.length) parts.push(e.message);
    } catch { /* ignore non-JSON line */ }
  }
  return parts.join("\n");
}
// ponytail: run_id isn't on stdout — pool writes session-<run_id>.json per turn. Newest one created
// after we started IS this turn's run (UUIDv7 filenames are time-ordered; single-flight-per-cwd bounds
// the race). Ceiling: two runs in *different* cwds finishing in the same instant could misattribute;
// upgrade path = parse the trajectory's session.start working_directories to disambiguate.
function captureRunId(startedAt){
  try {
    const files = readdirSync(SESSIONS_DIR)
      .filter(f => f.startsWith("session-") && f.endsWith(".json"))
      .map(f => { const p = join(SESSIONS_DIR, f); return { p, m: statSync(p).mtimeMs }; })
      .filter(x => x.m >= startedAt - 2000)   // small clock-skew slack
      .sort((a, b) => b.m - a.m);
    if (!files.length) return null;
    const j = JSON.parse(readFileSync(files[0].p, "utf8"));
    return typeof j.run_id === "string" ? j.run_id : null;
  } catch { return null; }
}

// ---------- the run ----------
async function runPool({ prompt, cwd, timeout_s, continueSession }){
  guardBinary();                       // INV1
  guardModel();                        // INV4
  guardPrompt(prompt);                 // INV5
  const real = guardCwd(cwd);          // INV3
  invariant(!inflight.has(real), `a laguna-wire run is already in progress for ${real} (laguna_cancel first)`); // INV9
  const to = clampTimeout(timeout_s);  // INV6

  const args = ["exec", "-o", "json", "--unsafe-auto-allow", "-d", real];
  if (continueSession) {
    const rid = lastRunId.get(real);
    args.push("--continue", ...(rid ? [rid] : []));   // explicit run-id per cwd; bare = "last message" fallback
  }
  args.push("-p", prompt);             // -p value: a leading-dash prompt is fine as the flag's value

  const startedAt = Date.now();
  const child = spawn(RESOLVED_BIN, args, {
    cwd: real,
    env: { ...process.env, PATH: childPath(), PWD: real },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,                    // own process group → kill whole tree on timeout
  });
  inflight.set(real, { child, startedAt });

  let out = "", err = "", size = 0;
  const cap = (buf, isErr) => {
    if (size >= OUTPUT_CAP) return;
    const s = buf.toString(); size += s.length;
    if (isErr) err += s; else out += s;
  };
  child.stdout.on("data", b => cap(b, false));
  child.stderr.on("data", b => cap(b, true));

  let timedOut = false, watchdog = null;
  const killTree = (sig) => {                 // INV6/M2: never signal pid 0/-0/NaN/self-group
    const pid = child.pid;
    if (!Number.isInteger(pid) || pid <= 1) return;
    try { process.kill(-pid, sig); } catch { /* group already gone */ }
  };

  try {
    await new Promise((res) => {
      const t = setTimeout(() => {                       // INV6 primary kill
        timedOut = true;
        killTree("SIGTERM");
        watchdog = setTimeout(() => killTree("SIGKILL"), 5000); // INV6 guard-on-guard
      }, to * 1000);
      const done = () => { clearTimeout(t); if (watchdog) clearTimeout(watchdog); res(); };
      child.on("close", done);
      child.on("error", done);
    });
  } finally {
    inflight.delete(real);
  }

  const exit = child.exitCode;
  const runId = captureRunId(startedAt);
  if (runId) lastRunId.set(real, runId);       // chain forward: next reply continues from here
  const files = gitChanges(real);
  const finalText = extractFinal(out) || out;
  const statusStr = timedOut ? "timeout" : exit === 0 ? "ok" : exit === 4 ? "incomplete" : "error";

  const body = [
    `status: ${statusStr}`,
    `exit_code: ${exit}`,
    `model: ${MODEL} (pool account default; not settable via 'pool exec')   cwd: ${real}`,
    runId ? `run_id: ${runId} (laguna_reply continues from here)` : `run_id: (not captured — laguna_reply will use 'last message')`,
    files.length ? `files_changed:\n  ${files.join("\n  ")}` : "files_changed: (none detected)",
    ``,
    `--- output ---`,
    finalText.slice(0, OUTPUT_CAP),
    err.trim() ? `\n--- stderr (tail) ---\n${err.slice(-4000)}` : ``,
  ].join("\n");

  return { isError: timedOut || exit !== 0, text: body };
}

function cancel(cwd){
  const real = (() => { try { return guardCwd(cwd); } catch { return realpathAbs(cwd ?? ""); } })();
  const rec = inflight.get(real);
  if (!rec) return { content: [{ type: "text", text: `no in-flight laguna-wire run for ${real}` }] };
  const pid = rec.child.pid;                    // M2: validate before negating
  if (Number.isInteger(pid) && pid > 1) { try { process.kill(-pid, "SIGTERM"); } catch {} }
  inflight.delete(real);
  return { content: [{ type: "text", text: `cancelled laguna-wire run for ${real}` }] };
}
function status(cwd){
  if (cwd) {
    const real = realpathAbs(cwd);
    const rec = inflight.get(real);
    const text = rec ? `running: ${real} (${Math.round((Date.now() - rec.startedAt) / 1000)}s, pid ${rec.child.pid})`
                     : `idle: ${real}`;
    return { content: [{ type: "text", text }] };
  }
  const rows = [...inflight.entries()].map(([k, v]) =>
    `${k}  (${Math.round((Date.now() - v.startedAt) / 1000)}s, pid ${v.child.pid})`);
  return { content: [{ type: "text", text: rows.length ? `in-flight runs:\n  ${rows.join("\n  ")}` : "no in-flight runs" }] };
}

// ---------- guards-on-guards: boot self-test (fail-closed) ----------
function expectReject(fn, label){
  try { fn(); } catch (e) { if (e instanceof GuardError) return; }
  throw new Error(`GUARD SELF-TEST FAILED: ${label} did not reject bad input`);
}
function selfTest(){
  // INV3 containment logic — the classic prefix-bypass bug:
  if (isContained(ALLOW_ROOT + "_evil_sibling")) throw new Error("SELF-TEST FAILED: containment sibling-prefix bypass");
  if (!isContained(ALLOW_ROOT + sep + "proj"))    throw new Error("SELF-TEST FAILED: containment rejects valid child");
  if (!isContained(ALLOW_ROOT))                   throw new Error("SELF-TEST FAILED: containment rejects root itself");
  // INV3 fs guards:
  expectReject(() => guardCwd(""),               "guardCwd(empty)");
  expectReject(() => guardCwd("relative/path"),  "guardCwd(relative)");
  expectReject(() => guardCwd("/"),              "guardCwd(root)");
  expectReject(() => guardCwd("/no-such-dir-" + "x".repeat(12)), "guardCwd(missing)");
  // INV5:
  expectReject(() => guardPrompt(""),                        "guardPrompt(empty)");
  expectReject(() => guardPrompt("   "),                     "guardPrompt(whitespace)");
  expectReject(() => guardPrompt("x".repeat(PROMPT_MAX + 1)),"guardPrompt(too-long)");
  // INV4:
  expectReject(() => invariant(MODEL_RE.test("evil/model"), "bad model"), "guardModel(bad)");
  // INV6 clamp:
  if (clampTimeout(1) !== TIMEOUT_MIN_S)   throw new Error("SELF-TEST FAILED: clamp min");
  if (clampTimeout(1e9) !== TIMEOUT_MAX_S) throw new Error("SELF-TEST FAILED: clamp max");
  if (clampTimeout(600) !== 600)           throw new Error("SELF-TEST FAILED: clamp passthrough");
  if (clampTimeout("x") !== TIMEOUT_DEF_S) throw new Error("SELF-TEST FAILED: clamp default");
  // INV7 NLJSON extraction:
  const sample = '{"message":"HELLO","type":"assistantMessage"}\n{"args":{},"name":"exit","type":"toolCall"}';
  if (extractFinal(sample) !== "HELLO") throw new Error("SELF-TEST FAILED: extractFinal(assistantMessage)");
}

// ---------- tool defs ----------
const TOOLS = [
  { name: "laguna_implement_plan",
    description: "Delegate a coding task/plan to Laguna S 2.1 (poolside `pool exec`, auto-approve, one-shot). Frontier-class long-horizon agentic coder, 1M context. Edits + runs commands autonomously inside cwd.",
    inputSchema: { type: "object", additionalProperties: false,
      properties: {
        prompt:    { type: "string", description: "Task/plan for Laguna to implement. State an explicit success criterion." },
        cwd:       { type: "string", description: "Absolute project dir; must be inside the allowed root (a git repo so files_changed populates)" },
        timeout_s: { type: "number", description: "default 1800; clamped 30..3600" },
      }, required: ["prompt", "cwd"] } },
  { name: "laguna_reply",
    description: "Continue the most recent Laguna conversation in cwd with a follow-up (pool exec --continue).",
    inputSchema: { type: "object", additionalProperties: false,
      properties: {
        user_input: { type: "string", description: "Follow-up instruction" },
        cwd:        { type: "string", description: "Absolute project dir of the conversation to continue" },
        timeout_s:  { type: "number", description: "default 1800; clamped 30..3600" },
      }, required: ["user_input", "cwd"] } },
  { name: "laguna_cancel",
    description: "Kill any in-flight laguna-wire run for cwd (SIGTERM the process group).",
    inputSchema: { type: "object", additionalProperties: false,
      properties: { cwd: { type: "string" } }, required: ["cwd"] } },
  { name: "laguna_status",
    description: "Report in-flight laguna-wire runs (all, or for one cwd).",
    inputSchema: { type: "object", additionalProperties: false,
      properties: { cwd: { type: "string" } } } },
];

async function startServer(){
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");

  const server = new Server({ name: "laguna-wire", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: a = {} } = req.params;
    try {
      if (name === "laguna_implement_plan")
        { const r = await runPool({ prompt: a.prompt, cwd: a.cwd, timeout_s: a.timeout_s, continueSession: false });
          return { isError: r.isError, content: [{ type: "text", text: r.text }] }; }
      if (name === "laguna_reply")
        { const r = await runPool({ prompt: a.user_input, cwd: a.cwd, timeout_s: a.timeout_s, continueSession: true });
          return { isError: r.isError, content: [{ type: "text", text: r.text }] }; }
      if (name === "laguna_cancel") return cancel(a.cwd);
      if (name === "laguna_status") return status(a.cwd);
      return { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `laguna-wire ${name} error: ${e.message}` }] };
    }
  });
  await server.connect(new StdioServerTransport());
  console.error("laguna-wire: ready (model " + MODEL + ", allow-root " + ALLOW_ROOT + ")");
}

// ---------- entry (only when run directly; importable for tests) ----------
function main(){
  if (process.argv.includes("--selfcheck")) {
    selfTest();
    console.log("laguna-wire: all guard self-tests passed");
    process.exit(0);
  }
  if (process.argv.includes("--checkbin")) {   // diagnostic: prove `pool` resolves under the current env
    try { guardBinary(); console.log("laguna-wire: backend resolved -> " + RESOLVED_BIN); process.exit(0); }
    catch (e) { console.error("laguna-wire: " + e.message); process.exit(1); }
  }
  selfTest();              // fail-closed: refuse to start if a guard is broken
  startServer().catch((e) => { console.error("laguna-wire fatal:", e); process.exit(1); });
}
const isMain = process.argv[1] && realpathAbs(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

export { runPool, cancel, status, extractFinal, captureRunId, gitChanges, clampTimeout, isContained, selfTest };
