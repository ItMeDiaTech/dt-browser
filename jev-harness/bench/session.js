// Live-session cost: log in once, then run goals in the same tab (cookies kept), versus a fresh login
// per goal, versus warm plan replay.  JEV_HEADLESS=1 JEV_SECRETS='{"www.saucedemo.com":{...}}' node bench/session.js
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secretsFor } from "../src/secrets.js";

const credential = secretsFor("https://www.saucedemo.com/");
if (!process.env.JEV_SECRETS && credential) process.env.JEV_SECRETS = JSON.stringify({ "www.saucedemo.com": credential });
process.env.JEV_HOME = mkdtempSync(join(tmpdir(), "jev-session-"));
const { Tab } = await import("../src/browser.js");
const { browse } = await import("../src/engine.js");
const { ok } = await import("./runner.js");

const INV = "https://www.saucedemo.com/inventory.html";
const GOALS = [
  { id: "sort", url: INV, goal: "Sort the products by price from low to high and report the name of the first product.", expect: "Sauce Labs Onesie" },
  { id: "jacket", url: INV, goal: "Open the Sauce Labs Fleece Jacket and report its price.", expect: "49.99" },
  { id: "cart-add", url: INV, goal: "Add the Sauce Labs Bike Light to the cart.", expect: null, expectUrl: "inventory" },
  { id: "cart-count", url: "https://www.saucedemo.com/cart.html", goal: "Report the name of the item in the shopping cart.", expect: "Bike Light" },
];
const LOGIN = { url: "https://www.saucedemo.com/", goal: "Log in to the site." };

// Every tab shares one Chrome profile, so cookies and localStorage (saucedemo keeps the cart there)
// leak between runs unless the site is reset explicitly.
const reset = (tab) => tab.resetOrigin("https://www.saucedemo.com/");
const clearCart = async (tab) => { await tab.goto(INV); await tab.evaluate("localStorage.removeItem('cart-contents')"); };
const rows = [];
async function run(regime, session, t, goal, url) {
  const r = await browse(session, goal, { url, maxSteps: 12 });
  rows.push({ regime, id: t.id, ok: ok(t, r), status: r.status, calls: r.jev.calls, tokens: r.jev.input_tokens, ms: r.elapsed_ms, steps: r.steps.length, notes: r.notes });
  console.error(`${regime} ${t.id}: ${r.status} ok=${ok(t, r)} ${r.jev.calls} calls ${r.jev.input_tokens} tok ${r.steps.length} steps ${r.notes?.join("; ") ?? ""}\n    ${r.url}\n    ${r.steps.join("\n    ")}`);
}

// Regime A: fresh tab, log in inside every goal (what a caller without sessions has to do).
for (const t of GOALS) {
  const s = { tab: await Tab.open() };
  await reset(s.tab);
  // The reset empties the cart; the cart question needs the item the previous goal added (id 0 = Bike Light).
  if (t.id === "cart-count") { await s.tab.goto(LOGIN.url); await s.tab.evaluate("localStorage.setItem('cart-contents', '[0]')"); }
  try { await run("fresh-login", s, t, `Log in and then: ${t.goal}`, LOGIN.url); } finally { await s.tab.close(); }
}
// Regime B: one tab, log in once, then the goals cold (no plans yet for these goals).
const s = { tab: await Tab.open() };
await reset(s.tab);
await run("session-login", s, { id: "login" }, LOGIN.goal, LOGIN.url);
for (const t of GOALS) await run("session-cold", s, t, t.goal, t.url);
// Regime C: same tab, same goals again: warm plan replay on a live session.
await clearCart(s.tab); // same state as the cold pass started from: logged in, empty cart
for (const t of GOALS) await run("session-warm", s, t, t.goal, t.url);
await s.tab.close();

const by = (regime) => rows.filter((r) => r.regime === regime);
const sum = (rs, k) => rs.reduce((a, r) => a + r[k], 0);
const lines = ["| regime | goals ok | Jev calls | Jev tokens | tokens / goal | wall ms |", "|---|---|---:|---:|---:|---:|"];
for (const regime of ["fresh-login", "session-cold", "session-warm"]) {
  const rs = by(regime); const login = regime === "session-cold" ? by("session-login") : [];
  lines.push(`| ${regime}${login.length ? " (+ one login: " + sum(login, "tokens").toLocaleString() + " tok)" : ""} | ${rs.filter((r) => r.ok).length}/${rs.length} | ${sum(rs, "calls")} | ${sum(rs, "tokens").toLocaleString()} | ${Math.round(sum(rs, "tokens") / rs.length).toLocaleString()} | ${sum(rs, "ms")} |`);
}
console.log(lines.join("\n"));
console.log("\n| regime | goal | ok | calls | tokens | steps |\n|---|---|---|---:|---:|---:|\n" + rows.map((r) => `| ${r.regime} | ${r.id} | ${r.ok ? "yes" : r.status} | ${r.calls} | ${r.tokens.toLocaleString()} | ${r.steps} |`).join("\n"));
writeFileSync(new URL("./session-results.json", import.meta.url), JSON.stringify({ date: new Date().toISOString(), rows }, null, 1));
