// Offline browser/model boundaries; the production engine and cache execute unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.JEV_HOME = mkdtempSync(join(tmpdir(), "jev-run-regression-"));
process.env.TYPESAFE_API_KEY = "test";
const { browse } = await import("../src/engine.js");
const { remember } = await import("../src/memory.js");
const { ask, JevError } = await import("../src/jev.js");

function fixture(pages, { irreversible = 0, delay = 0 } = {}) {
  let current = 0, clicks = 0;
  const url = `https://run-${Math.random().toString(16).slice(2)}.test/`;
  const observe = () => ({ url, title: "Fixture", scroll: { y: 0, max: 0 },
    elements: [{ i: 1, kind: "click", role: "button", label: "Next page" }], ...pages[Math.min(current, pages.length - 1)] });
  globalThis.fetch = async (_url, { body }) => {
    const { questions } = JSON.parse(body), page = observe();
    const answers = Object.fromEntries(Object.entries(questions).map(([id, q]) => {
      if (q.type === "noul") return [id, { noul: id === "irreversible" ? irreversible : id === "exhausted" ? +(page.end === true) : id.startsWith("f0_L") ? +/^L\d+\| (Ada|Ben|Cy|Dee|Eve)$/.test(q.instructions.line) : id === "exists" ? 1 : 0 }];
      const ids = Object.keys(q.criteria), choice = id === "action" ? ids.find((id) => id.startsWith("click_")) || "done" : ids[0];
      return [id, { choice, probabilities: Object.fromEntries(ids.map((id) => [id, +(id === choice)])) }];
    }));
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 1 } }));
  };
  const tab = { dialogs: [], goto: async () => {}, rendered: async () => {}, dismissBanners: async () => false,
    observe: async () => structuredClone(observe()), pageTargets: async () => new Set(), adoptPopup: async () => null,
    click: async () => { clicks++; current++; if (delay) await new Promise((resolve) => setTimeout(resolve, delay)); },
    settle: async () => {}, key: async () => {}, screenshot: async () => { throw new Error("no screenshot in offline fixture"); } };
  return { tab, url, clicks: () => clicks };
}

test("cached replay obeys zero and positive action budgets", async () => {
  delete process.env.JEV_NO_MEMORY;
  for (const budget of [0, 1]) {
    const f = fixture([{ lines: ["Result A"] }, { lines: ["Result B"] }, { lines: ["Result C"] }]);
    remember(f.url, "Complete fixture workflow.", Array.from({ length: 2 }, () => ({ op: "click", role: "button", label: "Next page" })));
    const result = await browse({ tab: f.tab }, "Complete fixture workflow.", { maxSteps: budget });
    assert.equal(f.clicks(), budget);
    assert.equal(result.status, "max_steps");
    assert.equal(result.steps.length, budget);
  }
});

test("cached replay stops before another action when its deadline expires", async () => {
  delete process.env.JEV_NO_MEMORY;
  const f = fixture([{ lines: ["Result A"] }], { delay: 25 });
  remember(f.url, "Complete timed workflow.", Array.from({ length: 2 }, () => ({ op: "click", role: "button", label: "Next page" })));
  const result = await browse({ tab: f.tab }, "Complete timed workflow.", { timeoutMs: 10 });
  assert.equal(result.status, "timeout");
  assert.ok(f.clicks() <= 1);
});

test("a last replay action that overruns its deadline cannot be reported done", async () => {
  delete process.env.JEV_NO_MEMORY;
  const f = fixture([{ lines: ["Result A"] }], { delay: 25 });
  remember(f.url, "Complete final timed workflow.", [{ op: "click", role: "button", label: "Next page" }]);
  const result = await browse({ tab: f.tab }, "Complete final timed workflow.", { timeoutMs: 10 });
  assert.equal(result.status, "timeout");
});

test("cached replay rechecks irreversible actions before clicking", async () => {
  delete process.env.JEV_NO_MEMORY;
  delete process.env.JEV_ALLOW_IRREVERSIBLE;
  const f = fixture([{ lines: ["Confirm action"] }], { irreversible: 1 });
  remember(f.url, "Complete guarded workflow.", [{ op: "click", role: "button", label: "Next page" }]);
  const result = await browse({ tab: f.tab }, "Complete guarded workflow.");
  assert.equal(result.status, "needs_confirmation");
  assert.equal(f.clicks(), 0);
});

test("saved popup workflows adopt the opened tab before replaying its next step", async () => {
  delete process.env.JEV_NO_MEMORY;
  const f = fixture([{ lines: ["Ready"], elements: [{ i: 1, role: "link", label: "Open popup", kind: "click" }] }]);
  let opened = false, opens = 0, finishes = 0;
  const popup = { ...f.tab, observe: async () => ({ url: f.url + "popup", title: "Popup", lines: [finishes ? "Workflow complete" : "Finish workflow"],
    scroll: { y: 0, max: 0 }, elements: [{ i: 1, role: "button", label: "Finish", kind: "click" }] }), click: async () => { finishes++; } };
  f.tab.reloads = ["opener reload note"];
  f.tab.click = async () => { opened = true; opens++; };
  f.tab.pageTargets = async () => new Set(opened ? ["opener", "popup"] : ["opener"]);
  f.tab.adoptPopup = async (before) => opened && !before.has("popup") ? popup : null;
  remember(f.url, "Open the popup and finish its workflow.", [{ op: "click", role: "link", label: "Open popup" }, { op: "click", role: "button", label: "Finish" }]);
  const session = { tab: f.tab };
  const result = await browse(session, "Open the popup and finish its workflow.", { maxSteps: 5 });
  assert.equal(result.status, "done");
  assert.equal(opens, 1);
  assert.equal(finishes, 1);
  assert.equal(session.tab, popup);
  assert.ok(result.notes.includes("opener reload note"));
});

test("list all accumulates pages and requires the end of the collection", async () => {
  process.env.JEV_NO_MEMORY = "1";
  const f = fixture([{ lines: ["Authors 1-3 of 5", "Ada", "Ben", "Cy"] },
    { lines: ["Authors 4-5 of 5", "Dee", "Eve"], elements: [], end: true }]);
  const result = await browse({ tab: f.tab }, "List all authors.", { maxSteps: 4 });
  assert.equal(result.status, "done");
  assert.deepEqual(result.items, ["Ada", "Ben", "Cy", "Dee", "Eve"]);
  assert.equal(f.clicks(), 1);
});

test("empty exhaustive collections require end evidence and return an empty items array", async () => {
  process.env.JEV_NO_MEMORY = "1";
  for (const end of [true, false]) {
    const f = fixture([{ lines: ["No authors; total 0"], elements: [{ i: 1, role: "button", label: "Refresh", kind: "click" }], end }]);
    const result = await browse({ tab: f.tab }, "List all authors.", { maxSteps: 1 });
    assert.equal(result.status === "done", end);
    assert.deepEqual(result.items, []);
  }
});

test("initial empty-page polling stops at the run deadline", async () => {
  process.env.JEV_NO_MEMORY = "1";
  const f = fixture([{ lines: ["Loading"], elements: [] }]);
  let observations = 0;
  const observe = f.tab.observe;
  f.tab.observe = async () => { observations++; return observe(); };
  const result = await browse({ tab: f.tab }, "Read the fixture.", { timeoutMs: 1 });
  assert.equal(result.status, "timeout");
  assert.equal(observations, 1);
});

test("last N waits for the final page and returns the trailing items in order", async () => {
  process.env.JEV_NO_MEMORY = "1";
  const f = fixture([{ lines: ["Ada", "Ben", "Cy"] }, { lines: ["Dee", "Eve"], elements: [], end: true }]);
  const result = await browse({ tab: f.tab }, "List the last 3 authors.", { maxSteps: 4 });
  assert.equal(result.status, "done");
  assert.deepEqual(result.items, ["Cy", "Dee", "Eve"]);
});

test("first N returns exactly that many items in order without fetching another page", async () => {
  process.env.JEV_NO_MEMORY = "1";
  const f = fixture([{ lines: ["Ada", "Ben", "Cy"] }]);
  const result = await browse({ tab: f.tab }, "List the first 2 authors.", { maxSteps: 4 });
  assert.equal(result.status, "done");
  assert.deepEqual(result.items, ["Ada", "Ben"]);
  assert.equal(f.clicks(), 0);
});

test("an incomplete exhaustive list is returned as partial instead of done", async () => {
  process.env.JEV_NO_MEMORY = "1";
  const f = fixture([{ lines: ["Authors 1-3 of 5", "Ada", "Ben", "Cy"] }]);
  const result = await browse({ tab: f.tab }, "List all authors.", { maxSteps: 1 });
  assert.equal(result.status, "max_steps");
  assert.deepEqual(result.items, ["Ada", "Ben", "Cy"]);
});

test("exhaustive lists include items beyond both the old per-list cap and text window", async () => {
  process.env.JEV_NO_MEMORY = "1";
  const names = Array.from({ length: 130 }, (_, i) => `Author ${i + 1}`);
  const f = fixture([{ lines: names, elements: [{ i: 1, role: "button", label: "Done", kind: "click" }], end: true }]);
  globalThis.fetch = async (_url, { body }) => {
    const { questions } = JSON.parse(body);
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { noul: 1 }])) }));
  };
  const result = await browse({ tab: f.tab }, "List all authors.");
  assert.equal(result.status, "done");
  assert.deepEqual(result.items, names);
});

test("same-length page changes do not prematurely trigger the repetition guard", async () => {
  process.env.JEV_NO_MEMORY = "1";
  const f = fixture(Array.from({ length: 6 }, (_, i) => ({ lines: [`Result ${String.fromCharCode(65 + i)}`] })));
  const result = await browse({ tab: f.tab }, "Advance through the fixture.", { maxSteps: 5 });
  assert.equal(result.status, "max_steps");
  assert.equal(f.clicks(), 5);
});

test("model probabilities outside the finite unit interval are rejected", async () => {
  for (const noul of [-1, 2]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ answers: { answer: { noul } } }));
    await assert.rejects(ask("fixture", { answer: { type: "noul", instructions: "yes?" } }), JevError);
  }
});

test("compound fills cannot execute more actions than the remaining budget", async () => {
  process.env.JEV_NO_MEMORY = "1";
  const values = ["", ""], typed = [];
  const page = () => ({ url: "https://form-budget.test/", title: "Form", lines: ["Names"], scroll: { y: 0, max: 0 },
    elements: values.map((value, i) => ({ i: i + 1, kind: "fill", role: "textbox", label: i ? "Last name" : "First name", value })) });
  globalThis.fetch = async (_url, { body }) => {
    const { questions } = JSON.parse(body);
    const answers = Object.fromEntries(Object.entries(questions).map(([id, q]) => {
      if (q.type === "noul") return [id, { noul: 0 }];
      const ids = Object.keys(q.criteria), choice = id === "action" ? "type_1" : id === "text_1" ? "Ada" : id === "text_2" ? "Ben" : ids[0];
      return [id, { choice, probabilities: Object.fromEntries(ids.map((key) => [key, +(key === choice)])) }];
    }));
    return new Response(JSON.stringify({ answers }));
  };
  const tab = { dialogs: [], observe: async () => structuredClone(page()), dismissBanners: async () => false,
    pageTargets: async () => new Set(), adoptPopup: async () => null, settle: async () => {},
    type: async (i, text) => { typed.push(i); values[i - 1] = text; }, screenshot: async () => { throw new Error("offline"); } };
  const result = await browse({ tab }, 'Fill first name "Ada" and last name "Ben".', { maxSteps: 1 });
  assert.deepEqual(typed, [1]);
  assert.equal(result.steps.length, 1);
  assert.equal(result.status, "max_steps");
});
