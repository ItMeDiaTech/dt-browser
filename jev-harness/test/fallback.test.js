import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ask, JevError, JevUnavailable, newUsage, runUsage } from "../src/jev.js";
import { browse } from "../src/engine.js";

const variables = ["TYPESAFE_API_KEY", "JEV_ENV_FILE", "JEV_FALLBACK", "JEV_FALLBACK_SHARE_DATA", "JEV_FALLBACK_URL", "JEV_FALLBACK_MODEL", "JEV_FALLBACK_API_KEY", "DT_BRIDGE_TOKEN", "JEV_NO_MEMORY"];
let saved, fetchBefore;
beforeEach(() => {
  saved = Object.fromEntries(variables.map((key) => [key, process.env[key]]));
  fetchBefore = globalThis.fetch;
  for (const key of variables) delete process.env[key];
  Object.assign(process.env, { TYPESAFE_API_KEY: "synthetic-primary-secret", DT_BRIDGE_TOKEN: "synthetic-bridge-secret", JEV_ENV_FILE: "missing-fixture.env", JEV_NO_MEMORY: "1" });
  globalThis.fetch = async () => { throw new Error("test must mock every request"); };
});
afterEach(() => {
  globalThis.fetch = fetchBefore;
  for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
});
const enable = () => Object.assign(process.env, { JEV_FALLBACK: "1", JEV_FALLBACK_SHARE_DATA: "1", JEV_FALLBACK_URL: "http://127.0.0.1:9999/v1/chat/completions", JEV_FALLBACK_MODEL: "gateway-small-model", JEV_FALLBACK_API_KEY: "synthetic-gateway-secret" });
const questions = { action: { type: "choice", instructions: "Select an action", criteria: { wait: null, done: null } }, safe: { type: "noul", instructions: "Is it safe?" } };
const answers = { action: { choice: "done", probabilities: { wait: 0, done: 1 } }, safe: { noul: 0.5 } };
const chat = (value = answers) => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ answers: value }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
const isPrimary = (url) => String(url) === "https://api.typesafe.ai/v1/systemone";

test("fallback is disabled by default, including when TypeSafe has no key", async () => {
  let calls = 0;
  globalThis.fetch = async (url) => { calls++; assert.ok(isPrimary(url)); return new Response("unavailable", { status: 401 }); };
  await assert.rejects(ask("fixture", questions), JevUnavailable);
  delete process.env.TYPESAFE_API_KEY;
  await assert.rejects(ask("fixture", questions), JevUnavailable);
  assert.equal(calls, 1);
});

test("healthy Jev stays primary even with fallback configured", async () => {
  enable();
  globalThis.fetch = async (url) => { assert.ok(isPrimary(url)); return new Response(JSON.stringify({ answers })); };
  assert.deepEqual(await ask("fixture", questions), answers);
});

test("availability failures alone route one judgment with separate auth and usage", async () => {
  enable();
  for (const status of [401, 402, 403, 429, 500, 503, 529]) {
    let primary = 0, fallback = 0;
    globalThis.fetch = async (url, request) => {
      if (isPrimary(url)) { primary++; return new Response("never forward this error body", { status, headers: { "retry-after": "0.001" } }); }
      fallback++;
      assert.equal(request.headers.authorization, "Bearer synthetic-gateway-secret");
      assert.equal(request.redirect, "error");
      assert.ok(!request.body.includes("synthetic-primary-secret"));
      assert.ok(!request.body.includes("synthetic-bridge-secret"));
      assert.ok(!request.body.includes("never forward"));
      const body = JSON.parse(request.body);
      assert.equal(body.model, "gateway-small-model");
      assert.deepEqual(JSON.parse(body.messages[1].content), { state: "fixture", questions });
      return chat();
    };
    const usage = newUsage();
    assert.deepEqual(await runUsage.run(usage, () => ask("fixture", questions)), answers);
    assert.equal(primary, [429, 503, 529].includes(status) ? 4 : 1);
    assert.equal(fallback, 1);
    assert.equal(usage.calls, 0);
    assert.equal(usage.fallback.input_tokens, 10);
    assert.equal(usage.fallback.cost_usd, null);
  }
});

test("missing primary key and exhausted network retries permit configured fallback", async () => {
  enable();
  let primary = 0, fallback = 0;
  globalThis.fetch = async (url) => {
    if (isPrimary(url)) { primary++; throw new TypeError("synthetic-primary-secret"); }
    fallback++; return chat();
  };
  await ask("fixture", questions);
  assert.equal(primary, 3);
  delete process.env.TYPESAFE_API_KEY;
  await ask("fixture", questions);
  assert.equal(fallback, 2);
});

test("invalid requests, invalid answers and cancellation never switch services", async () => {
  enable();
  for (const response of [() => new Response("bad request", { status: 400 }), () => new Response("bad request", { status: 422 }),
    () => new Response("not JSON"), () => new Response(JSON.stringify({ answers: { ...answers, safe: { noul: 2 } } })),
    () => { throw new DOMException("cancelled", "AbortError"); }]) {
    let requests = 0;
    globalThis.fetch = async (url) => { requests++; assert.ok(isPrimary(url)); return response(); };
    await assert.rejects(ask("fixture", questions));
    assert.equal(requests, 1);
  }
});

test("fallback requires explicit data sharing and complete transport configuration", async () => {
  for (const [key, value] of [["JEV_FALLBACK_SHARE_DATA", "0"], ["JEV_FALLBACK_MODEL", ""], ["JEV_FALLBACK_API_KEY", ""],
    ["JEV_FALLBACK_URL", "http://remote.test/v1/chat/completions"], ["JEV_FALLBACK_URL", "https://user:pass@gateway.test/v1/chat/completions"],
    ["JEV_FALLBACK_URL", "https://gateway.test/v1/chat/completions?key=synthetic-secret"]]) {
    enable(); process.env[key] = value;
    globalThis.fetch = async (url) => { assert.ok(isPrimary(url)); return new Response("down", { status: 401 }); };
    await assert.rejects(ask("fixture", questions), JevError);
  }
});

test("TypeSafe error bodies and malformed responses never expose echoed credentials", async () => {
  for (const status of [200, 401]) {
    globalThis.fetch = async () => new Response("synthetic-primary-secret synthetic-bridge-secret", { status });
    await assert.rejects(ask("fixture", questions), (error) => error instanceof JevError && !/synthetic-.*-secret/.test(error.message));
  }
});

test("malformed gateway output, unknown choices and failed gateway calls are never retried", async () => {
  enable();
  for (const response of [() => chat({ ...answers, action: { choice: "delete", probabilities: { wait: 0, done: 1 } } }),
    () => chat({ ...answers, safe: { noul: -1 } }), () => chat({ ...answers, extra: { noul: 1 } }),
    () => new Response("synthetic-gateway-secret", { status: 503 }), () => new Response("synthetic-gateway-secret"),
    () => { throw new Error("synthetic-gateway-secret"); }]) {
    let fallback = 0;
    globalThis.fetch = async (url) => {
      if (isPrimary(url)) return new Response("synthetic-primary-secret", { status: 401 });
      fallback++; return response();
    };
    await assert.rejects(ask("fixture", questions), (error) => error instanceof JevError && !/synthetic-.*-secret/.test(error.message));
    assert.equal(fallback, 1);
  }
});

test("switching judgment providers mid-run never replays an already executed action", async () => {
  enable();
  let clicks = 0, decisions = 0;
  globalThis.fetch = async (url, request) => {
    let q;
    if (isPrimary(url)) {
      q = JSON.parse(request.body).questions;
      if (clicks) return new Response("quota exhausted", { status: 402 });
    } else {
      const data = JSON.parse(JSON.parse(request.body).messages[1].content);
      q = data.questions;
      if (q.action) assert.equal(data.state.recent_actions.length, 1);
    }
    if (q.action) decisions++;
    const value = Object.fromEntries(Object.entries(q).map(([id, question]) => {
      if (question.type === "noul") return [id, { noul: ["irreversible", "stuck"].includes(id) ? 0 : +!!clicks }];
      const ids = Object.keys(question.criteria), choice = id === "action" ? clicks ? "done" : "click_1" : ids[0];
      return [id, { choice, probabilities: Object.fromEntries(ids.map((key) => [key, +(key === choice)])) }];
    }));
    return isPrimary(url) ? new Response(JSON.stringify({ answers: value })) : chat(value);
  };
  const tab = { dialogs: [], dismissBanners: async () => {}, assertAllowed: async () => {},
    observe: async () => ({ url: "https://fixture.test/", title: "Fixture", lines: [clicks ? "Applied" : "Ready"], scroll: { y: 0, max: 0 },
      elements: clicks ? [] : [{ i: 1, kind: "click", role: "button", label: "Apply" }] }),
    pageTargets: async () => new Set(), adoptPopup: async () => null, click: async () => { clicks++; }, settle: async () => {},
    screenshot: async () => { throw new Error("fixture has no screenshot"); } };
  const result = await browse({ tab }, "Apply the change.", { maxSteps: 3 });
  assert.equal(result.status, "done");
  assert.equal(clicks, 1);
  assert.equal(decisions, 2);
  assert.equal(result.steps.length, 1);
  assert.ok(result.fallback.calls > 0);
});

for (const phase of ["fetch", "primary-json", "gateway-json", "final-evidence", "extract", "list-extract", "confirmation"]) test(`cancellation during ${phase} permits no later provider traffic`, async () => {
  enable();
  const cancellation = new DOMException("fixture cancelled", "AbortError");
  let primary = 0, gateway = 0, afterCancel = 0, cancelled = false;
  const abort = () => { cancelled = true; throw cancellation; };
  globalThis.fetch = async (url, request) => {
    if (cancelled) afterCancel++;
    const main = isPrimary(url);
    if (main) primary++; else gateway++;
    if (cancelled || (phase === "gateway-json" && main)) return main ? new Response("auth failed", { status: 401 }) : chat();
    if (phase === "fetch" || phase === "final-evidence" || phase === "list-extract") return abort();
    if (phase === "primary-json" || phase === "gateway-json") return { ok: true, json: async () => abort() };
    const { questions } = JSON.parse(request.body);
    if ((phase === "extract" && questions.f0) || (phase === "confirmation" && questions.answers)) return abort();
    const value = Object.fromEntries(Object.entries(questions).map(([id, q]) => {
      if (q.type === "noul") return [id, { noul: ["outcome_visible", "exists"].includes(id) ? 1 : 0 }];
      const ids = Object.keys(q.criteria), choice = id === "action" ? "done" : ids[0];
      return [id, { choice, probabilities: Object.fromEntries(ids.map((key) => [key, +(key === choice)])) }];
    }));
    return new Response(JSON.stringify({ answers: value }));
  };
  let actions = 0;
  const tab = { dialogs: [], assertAllowed: async () => {}, dismissBanners: async () => {},
    observe: async () => ({ url: "https://fixture.test/", title: "Fixture", lines: ["Ready"], scroll: { y: 0, max: 0 },
      elements: [{ i: 1, kind: "click", role: "button", label: "Apply" }] }),
    click: async () => { actions++; }, screenshot: async () => { throw new Error("no fixture screenshot"); } };
  const goal = phase === "list-extract" ? "List all fixture names." : phase === "confirmation" ? "Report fixture status." : "Complete fixture.";
  const opts = { fields: { title: "title" }, ...(["final-evidence", "extract"].includes(phase) ? { maxSteps: 0 } : {}) };
  await assert.rejects(browse({ tab }, goal, opts), (error) => error === cancellation, phase);
  assert.equal(afterCancel, 0, `${phase}: no traffic after cancellation`);
  assert.equal(actions, 0);
  assert.equal(gateway, phase === "gateway-json" ? 1 : 0);
  assert.equal(primary, ["extract", "confirmation"].includes(phase) ? 2 : 1);
});
