// Soak test: run the real MCP server (src/cli.js mcp) and drive it with a continuous mix of tool calls
// until it dies, a call hangs, or the time limit passes. Every server stderr line goes to the log, so
// an uncaught error keeps its stack. Hunts the one-off crash seen in a held-out run (2026-09-23).
// Run:  node bench/soak.js [hours=2] [log=soak.log]    (bench site on :8911 for the local tasks)
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { TASKS as HELDOUT } from "./heldout.js";
import { TASKS as SUITE } from "./suite.js";

const [hours = "2", logFile = join(process.cwd(), "soak.log")] = process.argv.slice(2);
const until = Date.now() + Number(hours) * 3600e3;
const CALL_LIMIT_MS = 5 * 60e3; // browse caps itself at 150 s; a call past this is a hang
const log = (s) => { const line = `${new Date().toISOString()} ${s}`; appendFileSync(logFile, line + "\n"); console.error(line); };

// Plans, learned search URLs and the trace go to a throwaway home, not the user's ~/.jev-harness.
const env = { ...process.env, JEV_HOME: mkdtempSync(join(tmpdir(), "jev-soak-")), JEV_TRACE: "1" };
const server = spawn(process.execPath, [new URL("../src/cli.js", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"), "mcp"], { env, stdio: ["pipe", "pipe", "pipe"] });
let exited = null;
server.on("exit", (code, signal) => { exited = { code, signal }; log(`SERVER EXIT code=${code} signal=${signal}`); });
createInterface({ input: server.stderr }).on("line", (l) => log(`[server stderr] ${l}`));
const pending = new Map();
createInterface({ input: server.stdout }).on("line", (l) => {
  let m; try { m = JSON.parse(l); } catch { return log(`[server stdout, not JSON] ${l.slice(0, 300)}`); }
  pending.get(m.id)?.(m); pending.delete(m.id);
});
let id = 0;
const rpc = (method, params) => new Promise((resolve, reject) => {
  if (exited) return reject(new Error("server exited"));
  const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(new Error(`HANG: ${method} ${params?.name ?? ""} > ${CALL_LIMIT_MS / 1000}s`)); }, CALL_LIMIT_MS);
  pending.set(n, (m) => { clearTimeout(timer); resolve(m); });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
});

const tasks = [...HELDOUT, ...SUITE].map((t) => ({ goal: t.goal, url: t.url }));
const pick = () => tasks[Math.floor(Math.random() * tasks.length)];
const CALLS = [
  [5, () => ({ name: "browse", arguments: pick() })],
  [2, () => ({ name: "browse_many", arguments: { tasks: [pick(), pick(), pick()], concurrency: 3 } })],
  [2, () => { const t = pick(); return { name: "read", arguments: { url: t.url, extract: { title: "page title", price: { type: "number", description: "a price" } } } }; }],
  [1, () => ({ name: "browse", arguments: { goal: pick().goal } })], // continue in the live tab, whatever it holds
  [1, () => ({ name: "session_reset", arguments: { url: pick().url } })],
];
const weighted = CALLS.flatMap(([w, f]) => Array(w).fill(f));

await rpc("initialize", {});
log(`soak start: ${hours} h, ${tasks.length} tasks, server pid ${server.pid}, JEV_HOME ${env.JEV_HOME}`);
let calls = 0, errors = 0, failed = false;
while (Date.now() < until && !exited) {
  const call = weighted[Math.floor(Math.random() * weighted.length)]();
  const t0 = Date.now();
  try {
    const m = await rpc("tools/call", call);
    calls++;
    const text = m.result?.content?.[0]?.text ?? "";
    if (m.result?.isError) errors++;
    let status = ""; try { const o = JSON.parse(text); status = o.status ?? o.results?.map((r) => r.status).join(",") ?? "ok"; } catch { status = text.slice(0, 160); }
    log(`#${calls} ${call.name} ${Date.now() - t0}ms ${m.result?.isError ? "TOOL-ERROR " : ""}${status} :: ${(call.arguments.goal || call.arguments.url || "").slice(0, 70)}`);
  } catch (e) {
    failed = true;
    log(`#${calls + 1} ${call.name} FAILED after ${Date.now() - t0}ms: ${e.message}`);
    if (e.message.startsWith("HANG")) { log("stopping: hung call"); break; }
  }
}
log(`soak end: ${calls} calls, ${errors} tool errors, server ${exited ? `EXITED ${JSON.stringify(exited)}` : "alive"}`);
const runFailed = failed || !!exited;
server.stdin.end();
setTimeout(() => {
  const shutdownFailed = !exited || exited.code !== 0 || !!exited.signal;
  server.kill();
  process.exit(runFailed || shutdownFailed ? 1 : 0);
}, 5000);
