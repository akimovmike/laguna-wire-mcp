// Live end-to-end smoke: drives the real runPool() against a throwaway git repo.
// Requires `pool` installed + authed. Root passed via LAGUNA_SMOKE_ROOT (must contain the repo).
import { existsSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const root = process.env.LAGUNA_SMOKE_ROOT;
if (!root) { console.error("set LAGUNA_SMOKE_ROOT"); process.exit(2); }
process.env.LAGUNA_WIRE_ALLOW_ROOT = root;          // must be set BEFORE importing index.mjs (read at load)

const repo = join(root, "laguna-smokerepo");
rmSync(repo, { recursive: true, force: true });
execFileSync("git", ["init", "-q", repo]);

const { runPool } = await import("../index.mjs");

let fail = 0;
const check = (name, cond) => { console.log((cond ? "PASS" : "FAIL") + ": " + name); if (!cond) fail++; };

console.log(">>> implement");
const r1 = await runPool({
  prompt: "Create a file named hello.txt containing exactly the text 'hi' (one line). Success = hello.txt exists with that content.",
  cwd: repo, timeout_s: 240, continueSession: false,
});
console.log(r1.text);
check("implement not error", !r1.isError);
check("hello.txt created", existsSync(join(repo, "hello.txt")));
check("files_changed lists hello.txt", /hello\.txt/.test(r1.text));
check("run_id captured", /run_id: [0-9a-f]{8}-/.test(r1.text));

console.log("\n>>> reply (--continue)");
const r2 = await runPool({
  prompt: "Append a second line containing exactly 'bye' to hello.txt. Success = the file has two lines: hi then bye.",
  cwd: repo, timeout_s: 240, continueSession: true,
});
console.log(r2.text);
check("reply not error", !r2.isError);
const content = existsSync(join(repo, "hello.txt")) ? readFileSync(join(repo, "hello.txt"), "utf8") : "";
check("hello.txt now contains 'bye' (continuation worked)", /bye/.test(content));

console.log("\n" + (fail ? `SMOKE FAILED (${fail})` : "SMOKE PASSED"));
process.exit(fail ? 1 : 0);
