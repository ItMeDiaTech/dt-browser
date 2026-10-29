// Live (Chrome): a GET answered with a transient error status is reloaded once; a POST never is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Tab } from "../src/browser.js";

test("a transient 403 on a GET is reloaded once; an erroring POST is not resubmitted", async () => {
  const hits = { get: 0, post: 0 };
  const server = createServer((req, res) => {
    if (req.method === "POST") { hits.post++; res.writeHead(503, { "content-type": "text/html" }); return res.end("<title>Busy</title>busy"); }
    if (req.url === "/form") { res.writeHead(200, { "content-type": "text/html" }); return res.end('<form method="post" action="/submit"><button>Send</button></form>'); }
    if (!req.url.startsWith("/search")) { res.writeHead(404); return res.end(); } // favicon etc.
    hits.get++;
    res.writeHead(hits.get === 1 ? 403 : 200, { "content-type": "text/html" });
    res.end(hits.get === 1 ? "<title>Error Page</title>Something went wrong" : "<title>Results</title>ok");
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const t = await Tab.open();
  try {
    await t.goto(`${base}/search?q=x`);
    assert.equal(await t.evaluate("document.title"), "Results");
    assert.deepEqual(t.reloads, ["reloaded after HTTP 403"]);
    await t.goto(`${base}/form`);
    const p = await t.observe();
    await t.click(p.elements.find((e) => e.label === "Send").i); await t.settle();
    assert.equal(await t.evaluate("document.title"), "Busy");
    assert.equal(hits.post, 1, "the POST was not resubmitted");
    assert.equal(t.reloads.length, 1);
  } finally { await t.close(); server.closeAllConnections(); server.close(); }
});
