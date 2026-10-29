// Live (Chrome + bench site on :8911): open shadow roots, same-origin iframes and cross-origin
// (out-of-process) iframes are indexed, read, and actionable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Tab } from "../src/browser.js";

const SITE = process.env.BENCH_SITE || "http://127.0.0.1:8911";
const find = (p, prefix) => p.elements.find((e) => e.label.startsWith(prefix));
// A missing fixture used to fail as "Cannot read properties of undefined (reading 'i')".
const pick = (p, prefix) => {
  const e = find(p, prefix);
  assert.ok(e, `no "${prefix}" element on ${p.url}; saw: ${p.elements.map((x) => x.label).slice(0, 8).join(" | ") || "none"}`);
  return e;
};

// Chrome serves a cached nested.html while the fixture server is down, but not its frames, so the
// page cannot tell us the server is missing: probe it. Without it these checks measure nothing.
// A server started alongside the suite can miss the first probe, so keep asking for a few seconds.
const probe = () => fetch(`${SITE}/nested.html`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);
let SITE_UP = false;
for (let k = 0; k < 10 && !SITE_UP; k++) {
  SITE_UP = await probe();
  if (!SITE_UP) await new Promise((r) => setTimeout(r, 300));
}
const skipReason = `bench site not serving at ${SITE} — run "python -m http.server 8911" in bench/site`;
const live = SITE_UP ? test : (name, fn) => test(name, { skip: skipReason }, fn);

// A server that dies mid-run must not turn into a fixture failure: the cached page still loads while
// its frames refuse, which reads as "no Gift card element". Probe before the navigation, and after a
// refused connection, so a dead server is a named skip and a live one still fails loudly.
const openAt = async (t, page) => {
  if (!(await probe())) { t.skip(skipReason); return null; }
  const tab = await Tab.open();
  try {
    await tab.goto(`${SITE}/${page}`);
  } catch (e) {
    if (!/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET/.test(e.message)) throw e;
    await tab.close();
    t.skip(skipReason);
    return null;
  }
  return tab;
};

live("shadow DOM controls and text are visible and clickable", async (t) => {
  const tab = await openAt(t, "shadow.html");
  if (!tab) return;
  try {
    let p = await tab.observe();
    assert.ok(p.lines.some((l) => l.includes("$9.99")), "shadow text in lines");
    await tab.click(pick(p, "Add to cart").i); await tab.settle();
    p = await tab.observe();
    assert.ok(p.lines.includes("Added SteelSeries QcK Mouse Pad to your cart."));
    await tab.type(p.elements.find((e) => e.kind === "fill").i, "usb hub", true); await tab.settle();
    assert.match(await tab.evaluate("location.href"), /results\.html\?q=usb\+hub/);
  } finally { await tab.close(); }
});

live("same-origin and cross-origin iframe fields can be typed into and submitted", async (t) => {
  const tab = await openAt(t, "frames.html");
  if (!tab) return;
  try {
    for (let k = 0; k < 20 && !find(await tab.observe(), "Coupon code"); k++) await new Promise((r) => setTimeout(r, 100));
    let p = await tab.observe();
    await tab.type(pick(p, "Gift message").i, "Happy birthday");
    await tab.click(pick(p, "Save message").i); await tab.settle();
    await tab.type(pick(p, "Coupon code").i, "save10", true); await tab.settle();
    p = await tab.observe();
    assert.ok(p.lines.includes("Gift message saved: Happy birthday"));
    assert.ok(p.lines.includes("Coupon SAVE10 applied: 10% off"));
  } finally { await tab.close(); }
});

live("a stored password is typed into the page's own field, never a cross-origin frame's", async (t) => {
  process.env.JEV_SECRETS = JSON.stringify({ "127.0.0.1": { username: "ada", password: "hunter2" } });
  process.env.JEV_NO_MEMORY = "1";
  const { browse } = await import("../src/engine.js");
  const tab = await openAt(t, "login_frames.html");
  if (!tab) { delete process.env.JEV_SECRETS; return; }
  const s = { tab };
  try {
    for (let k = 0; k < 20 && !find(await s.tab.observe(), "Partner password"); k++) await new Promise((r) => setTimeout(r, 100));
    const p = await s.tab.observe();
    assert.match(pick(p, "Partner password").frame, /^http:\/\/localhost:/, "frame elements carry their own URL");
    const r = await browse(s, "Sign in with my stored credentials.", {});
    assert.equal(r.status, "done", JSON.stringify(r.steps));
    const after = await s.tab.observe();
    assert.ok(after.lines.includes("Welcome back, ada"));
    assert.equal(find(after, "Partner password").value, "", "the frame's password field stays empty");
  } finally { await s.tab.close(); delete process.env.JEV_SECRETS; }
});

live("closed shadow roots are indexed and actionable, and stay closed to the page", async (t) => {
  const tab = await openAt(t, "closed_shadow.html");
  if (!tab) return;
  try {
    let p = await tab.observe();
    assert.ok(p.lines.includes("Member price: $19.99"));
    await tab.type(pick(p, "Promo code").i, "SPRING");
    await tab.click(pick(p, "Redeem").i); await tab.settle();
    assert.ok((await tab.observe()).lines.includes("Promo SPRING redeemed"));
    assert.equal(await tab.evaluate("document.querySelector('vault-box').shadowRoot"), null);
  } finally { await tab.close(); }
});

live("a cross-origin frame inside another cross-origin frame is indexed and actionable", async (t) => {
  const tab = await openAt(t, "nested.html");
  if (!tab) return;
  try {
    for (let k = 0; k < 30 && !find(await tab.observe(), "Gift card"); k++) await new Promise((r) => setTimeout(r, 100));
    let p = await tab.observe();
    assert.match(pick(p, "Gift card").frame, /^http:\/\/127\.0\.0\.2:/);
    await tab.type(pick(p, "Gift card").i, "GC-42");
    await tab.click(pick(p, "Check balance").i); await tab.settle();
    assert.ok((await tab.observe()).lines.includes("Gift card GC-42 accepted"));
  } finally { await tab.close(); }
});
