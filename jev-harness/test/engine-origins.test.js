import { test } from "node:test";
import assert from "node:assert/strict";

process.env.JEV_ALLOWED_ORIGINS = "allowed.test";
process.env.JEV_NO_MEMORY = "1";
process.env.TYPESAFE_API_KEY = "test";
const { browse } = await import("../src/engine.js");

test("a blocked initial document is neither dismissed nor sent to the model", async () => {
  let dismissals = 0, requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("must not call model"); };
  const tab = { dialogs: [], observe: async () => ({ url: "https://blocked.test/", title: "Private", lines: ["private text"], elements: [{ i: 1, role: "button", label: "Private control" }], scroll: { y: 0, max: 0 } }),
    dismissBanners: async () => { dismissals++; }, screenshot: async () => { throw new Error("must not capture"); } };
  const result = await browse({ tab }, "Read the private page.", { fields: { title: "page title" } });
  assert.equal(result.status, "blocked_origin");
  assert.equal(dismissals, 0);
  assert.equal(requests, 0);
  assert.equal(result.title, "");
  assert.equal(result.elements, "");
});
