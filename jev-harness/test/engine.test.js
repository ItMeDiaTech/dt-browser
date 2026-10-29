import { test } from "node:test";
import assert from "node:assert/strict";
import { pick, planOf } from "../src/engine.js";
import { prune } from "../src/jev.js";

test("planOf keeps page-changing steps and drops a click undone by back", () => {
  const h = (op, label, changed = true) => ({ rec: { op, role: "link", label }, page_changed: changed });
  const plan = planOf([h("click", "Product"), h("click", "Deals"), h("back", undefined), h("click", "Deals"), h("back", undefined), h("click", "Cart", false)]);
  assert.deepEqual(plan.map((s) => s.label), ["Product"]);
});

test("prune keeps controls and goal-relevant links within the budget", () => {
  const els = [{ i: 1, kind: "fill", role: "searchbox", label: "Search" }, { i: 2, kind: "click", role: "button", label: "Go" }];
  for (let i = 3; i < 300; i++) els.push({ i, kind: "click", role: "link", label: i === 150 ? "Anker USB-C Hub" : `Item ${i}`, offscreen: i > 20 });
  const kept = prune(els, "open the Anker hub", 30);
  assert.equal(kept.length, 30);
  assert.ok(kept.some((e) => e.i === 1) && kept.some((e) => e.i === 2), "controls kept");
  assert.ok(kept.some((e) => e.i === 150), "goal-matching offscreen link kept");
  assert.deepEqual(kept.map((e) => e.i), [...kept.map((e) => e.i)].sort((a, b) => a - b), "document order preserved");
});

test("planOf refuses to remember a run that typed a password taken from the goal", () => {
  const h = [{ rec: { op: "type", role: "textbox", label: "Username", text: "u" }, page_changed: true },
    { rec: { op: "type", role: "password", label: "Password", text: "(password from goal)" }, page_changed: true }];
  assert.deepEqual(planOf(h), []);
});

test("planOf keeps only the last typing into the same field", () => {
  const t = (text, submit) => ({ rec: { op: "type", role: "textbox", label: "Search", text, submit }, page_changed: true });
  const plan = planOf([t("dress", false), t("dress", true), { rec: { op: "click", role: "button", label: "submit search", submitsSearch: true }, page_changed: true }]);
  assert.deepEqual(plan.map((s) => [s.op, s.submit ?? s.submitsSearch]), [["type", true], ["click", true]]);
});

test("pick stops re-clicking an in-place toggle whose label carries a counter, but keeps paging", () => {
  const e = (i, label) => ({ i, role: "button", label });
  const h = (label) => ({ id: "x", page_changed: true, navigated: false, rec: { op: "click", role: "button", label } });
  const toggle = { id: "click_7", op: "click", p: 0.9, e: e(7, "Used 12 tools Expand to see details") };
  const other = { id: "click_9", op: "click", p: 0.5, e: e(9, "Submit") };
  assert.equal(pick([toggle, other], [h("Used 10 tools Expand to see details")]), toggle);
  assert.equal(pick([toggle, other], [h("Used 10 tools Expand to see details"), h("Used 11 tools Expand to see details")]), other);
  const more = { id: "click_3", op: "click", p: 0.9, e: e(3, "Load more") };
  assert.equal(pick([more], [h("Load more"), h("Load more"), h("Load more")]), more);
});

test("botWall flags Cloudflare and captcha interstitials, not ordinary pages that mention them", async () => {
  const { botWall } = await import("../src/engine.js");
  assert.equal(botWall({ title: "Just a moment...", lines: ["namecheap.com"] }), true);
  assert.equal(botWall({ title: "x", lines: ["Verify you are human by completing the action below."] }), true);
  assert.equal(botWall({ title: "Docs", lines: ["How Cloudflare checks your browser", ...Array(50).fill("text")] }), false);
});

test("botWall flags PyPI's image captcha but not a login page protected by reCAPTCHA", async () => {
  const { botWall } = await import("../src/engine.js");
  assert.equal(botWall({ title: "Search results", lines: ["Enter the characters seen in the image below:", "Download audio CAPTCHA", "Answer"] }), true);
  assert.equal(botWall({ title: "Log in", lines: ["Username", "Password", "This site is protected by reCAPTCHA"] }), false);
});
