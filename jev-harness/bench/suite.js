// Task suite for measuring Jev cost per task (calls, input tokens, steps, wall time, success) and the
// orchestrator-visible result size. Run:  JEV_HEADLESS=1 node bench/suite.js [label] [reps]
// Writes bench/suite-<label>.json and prints a table; compare two labels with `node bench/suite.js --diff a b`.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SITE = process.env.BENCH_SITE || "http://127.0.0.1:8911";
export const TASKS = [
  { id: "price", url: `${SITE}/index.html`, goal: "Search the store for wireless mouse, open the Logitech M185 product page and report its price.", expect: "$14.99" },
  { id: "form", url: `${SITE}/index.html`, goal: "Subscribe to the newsletter as Ada Lovelace with email ada@example.com, weekly frequency, including partner deals.", expect: "Weekly digest with partner deals" },
  { id: "sort", url: `${SITE}/results.html?q=mouse`, goal: "Sort the results by price from low to high and report the name of the first product listed.", expect: "SteelSeries QcK Mouse Pad" },
  { id: "featured", url: `${SITE}/index.html`, goal: "Open the Keychron K2 keyboard from the featured list and report its price.", expect: "$79.00" },
  { id: "cart", url: `${SITE}/index.html`, goal: "Search for usb hub and add the Anker 7-in-1 USB-C Hub to the cart.", expect: "Added Anker 7-in-1 USB-C Hub to your cart" },
  { id: "catalog", url: `${SITE}/catalog.html`, goal: "Find the Anker 7-in-1 USB-C Hub in the clearance catalog, open it and report its price.", expect: "$34.99" },
  { id: "impossible", url: `${SITE}/index.html`, goal: "Log in to my account with username austin.", expect: null, expectStatus: ["stuck", "max_steps", "error"] },
  { id: "wiki", url: "https://en.wikipedia.org/wiki/Main_Page", goal: "Search Wikipedia for Grace Hopper and report the year she was born.", expect: "1906" },
  { id: "wiki2", url: "https://en.wikipedia.org/wiki/Main_Page", goal: "Search Wikipedia for the Python programming language and report who designed it.", expect: "Guido van Rossum" },
];

const score = (t, r) => t.expect
  ? ["done", "goal_achieved"].includes(r.status) && JSON.stringify(r.evidence).includes(t.expect)
  : t.expectStatus.includes(r.status);

async function run(label, reps) {
  process.env.JEV_HOME = mkdtempSync(join(tmpdir(), "jev-suite-"));
  const { runTask } = await import("./runner.js");
  const rows = [];
  for (let rep = 0; rep < reps; rep++) {
    for (const t of TASKS) {
      const { r, ok } = await runTask(t, { maxSteps: 15, score });
      const row = { task: t.id, rep, status: r.status, success: ok, steps: r.steps?.length ?? 0, jev_calls: r.jev.calls,
        jev_tokens: r.jev.input_tokens, ms: r.elapsed_ms, result_chars: JSON.stringify(r).length, notes: r.notes };
      rows.push(row);
      console.error(`${label} ${t.id}#${rep}: ${row.status} ok=${row.success} steps=${row.steps} jev=${row.jev_tokens}tok/${row.jev_calls}calls ${row.ms}ms`);
    }
  }
  writeFileSync(new URL(`./suite-${label}.json`, import.meta.url), JSON.stringify({ label, date: new Date().toISOString(), rows }, null, 1));
  return rows;
}

// rep 0 is the cold run (no remembered plan); later reps are warm (plan replay), reported apart.
function summarize(rows, which = "cold") {
  const by = {};
  for (const r of rows) if ((r.rep === 0) === (which === "cold")) (by[r.task] ??= []).push(r);
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  return Object.fromEntries(Object.entries(by).map(([task, rs]) => [task, {
    n: rs.length, success: rs.filter((r) => r.success).length, steps: med(rs.map((r) => r.steps)), calls: med(rs.map((r) => r.jev_calls)),
    jev_tokens: med(rs.map((r) => r.jev_tokens)), ms: med(rs.map((r) => r.ms)), result_chars: med(rs.map((r) => r.result_chars)) }]));
}

function table(label, s) {
  const lines = [`### ${label}`, "| task | ok | steps | Jev calls | Jev tokens | ms | result chars |", "|---|---|---:|---:|---:|---:|---:|"];
  let tok = 0, calls = 0, okn = 0, n = 0;
  for (const [t, r] of Object.entries(s)) { lines.push(`| ${t} | ${r.success}/${r.n} | ${r.steps} | ${r.calls} | ${r.jev_tokens.toLocaleString()} | ${r.ms} | ${r.result_chars} |`); tok += r.jev_tokens; calls += r.calls; okn += r.success; n += r.n; }
  lines.push(`| **total (medians)** | ${okn}/${n} | | ${calls} | ${tok.toLocaleString()} | | |`);
  return lines.join("\n");
}

// Importable (other benches reuse TASKS): only run when executed directly.
const main = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const [a, b, c] = process.argv.slice(2);
if (!main) {} else if (a === "--diff") {
  const load = (l) => summarize(JSON.parse(readFileSync(new URL(`./suite-${l}.json`, import.meta.url), "utf8")).rows, process.env.WHICH || "cold");
  const A = load(b), B = load(c);
  const lines = [`| task | Jev tokens ${b} | Jev tokens ${c} | change | calls ${b}→${c} | ok ${b}→${c} |`, "|---|---:|---:|---:|---|---|"];
  let ta = 0, tb = 0;
  for (const t of Object.keys(A)) { if (!B[t]) continue; ta += A[t].jev_tokens; tb += B[t].jev_tokens;
    lines.push(`| ${t} | ${A[t].jev_tokens.toLocaleString()} | ${B[t].jev_tokens.toLocaleString()} | ${((B[t].jev_tokens / A[t].jev_tokens - 1) * 100).toFixed(0)}% | ${A[t].calls}→${B[t].calls} | ${A[t].success}/${A[t].n}→${B[t].success}/${B[t].n} |`); }
  lines.push(`| **total** | ${ta.toLocaleString()} | ${tb.toLocaleString()} | ${((tb / ta - 1) * 100).toFixed(0)}% | | |`);
  console.log(lines.join("\n"));
} else {
  const rows = await run(a || "baseline", Number(b) || 1);
  console.log(table(`${a || "baseline"} (cold)`, summarize(rows, "cold")));
  if (rows.some((r) => r.rep > 0)) console.log("\n" + table(`${a || "baseline"} (warm: remembered plan)`, summarize(rows, "warm")));
}
