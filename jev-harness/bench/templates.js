// Plans with blanks and learned search URLs, live: each group runs a "learn" goal cold, then goals of
// the same shape with other values (which should replay the templated plan: one Jev call), then a goal
// of a different shape that searches (which should jump to the learned search URL).
// Run:  JEV_HEADLESS=1 node bench/templates.js   (uses a throwaway JEV_HOME; bench site on :8911)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.JEV_HOME = mkdtempSync(join(tmpdir(), "jev-tpl-"));
delete process.env.JEV_NO_MEMORY;
const { runTask } = await import("./runner.js");

const SITE = process.env.BENCH_SITE || "http://127.0.0.1:8911";
const GROUPS = [
  [
    { role: "learn", url: `${SITE}/index.html`, goal: "Search the store for wireless mouse, open the Logitech M185 product page and report its price.", expect: "$14.99" },
    { role: "variant", url: `${SITE}/index.html`, goal: "Search the store for usb hub, open the Anker 7-in-1 USB-C Hub product page and report its price.", expect: "$34.99" },
    { role: "variant", url: `${SITE}/index.html`, goal: "Search the store for keyboard, open the Keychron K2 Wireless Keyboard product page and report its price.", expect: "$79.00" },
    { role: "other shape", url: `${SITE}/index.html`, goal: "Search the store for mouse pad and report how many results there are.", expect: "results for" },
  ],
  [
    { role: "learn", url: `${SITE}/index.html`, goal: "Search for usb hub and add the Anker 7-in-1 USB-C Hub to the cart.", expect: "Added Anker" },
    { role: "variant", url: `${SITE}/index.html`, goal: "Search for wireless mouse and add the Logitech M330 Silent Wireless Mouse to the cart.", expect: "Added Logitech M330" },
  ],
  [
    { role: "learn", url: "https://automationexercise.com/products", goal: "Search for dress and report the name of the first product shown.", expect: "Dress" },
    { role: "variant", url: "https://automationexercise.com/products", goal: "Search for jeans and report the name of the first product shown.", expect: "Jeans" },
    { role: "variant", url: "https://automationexercise.com/products", goal: "Search for top and report the name of the first product shown.", expect: "Top" },
  ],
];

const rows = [];
for (const group of GROUPS) for (const t of group) {
  const { r, ok } = await runTask(t, { maxSteps: 12 });
  const how = r.notes?.some((n) => n.includes("template")) ? "template replay" : r.steps?.some((x) => x.includes("learned search URL")) ? "search URL" : "Jev loop";
  rows.push(`| ${t.goal.slice(0, 70)} | ${t.role} | ${ok ? "yes" : "NO"} | ${how} | ${r.steps?.length ?? 0} | ${r.jev.calls} | ${r.jev.input_tokens?.toLocaleString()} | ${r.elapsed_ms} |`);
  console.error(JSON.stringify({ goal: t.goal, status: r.status, ok, steps: r.steps, notes: r.notes, ev: r.evidence?.lines?.[0]?.line?.slice(0, 80) }));
}
console.log("| goal | role | ok | path | steps | Jev calls | Jev tokens | ms |\n|---|---|---|---|---:|---:|---:|---:|\n" + rows.join("\n"));
