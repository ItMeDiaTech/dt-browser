// Live checks (need Chrome): dismissal must not confirm destructive modals, confirm() dialogs are
// dismissed, and a closed tab fails fast instead of hanging. The fixture is served here unless
// BENCH_SITE names a running bench site, so a plain `npm test` runs the check instead of failing it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Tab } from "../src/browser.js";

let server, URL = process.env.BENCH_SITE && `${process.env.BENCH_SITE}/modal.html`;
if (!URL) {
  const html = readFileSync(new globalThis.URL("../bench/site/modal.html", import.meta.url));
  server = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(html); }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  URL = `http://127.0.0.1:${server.address().port}/modal.html`;
  after(() => { server.closeAllConnections(); server.close(); });
}

test("banner dismissal clears consent but never clicks OK in a generic modal; confirm() is dismissed", async () => {
  const tab = await Tab.open();
  try {
    await tab.goto(URL);
    await tab.dismissBanners();
    assert.equal(await tab.evaluate("document.title"), "Modal fixture");
    assert.equal(await tab.evaluate("!!document.querySelector('.cookie-banner')"), false);
    const page = await tab.observe();
    await tab.click(page.elements.find((e) => e.label.startsWith("Delete")).i);
    await tab.settle();
    assert.equal(await tab.evaluate("document.title"), "Modal fixture");
    assert.match(tab.dialogs[0], /^confirm dismissed/);
  } finally { await tab.close(); }
});

test("a closed tab rejects immediately", async () => {
  const tab = await Tab.open();
  await tab.close();
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  await assert.rejects(tab.evaluate("1"), /closed/);
  assert.ok(Date.now() - t0 < 1000);
});
