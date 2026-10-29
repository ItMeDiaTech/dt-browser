// Live (Chrome + bench site on :8911): resetting one origin clears its cookies and storage only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Tab } from "../src/browser.js";

const A = "http://127.0.0.1:8911/index.html", B = "http://localhost:8911/index.html";
const seed = "document.cookie = 'sid=1; path=/'; localStorage.setItem('k', 'v'); 'ok'";
const state = "JSON.stringify({ cookie: document.cookie, ls: localStorage.getItem('k') })";

test("resetOrigin clears the target site and leaves other sites alone", async () => {
  const tab = await Tab.open();
  try {
    for (const u of [A, B]) { await tab.goto(u); await tab.evaluate(seed); }
    const r = await tab.resetOrigin(A);
    assert.equal(r.origin, "http://127.0.0.1:8911");
    assert.ok(r.cookies_deleted >= 1);
    await tab.goto(A);
    assert.deepEqual(JSON.parse(await tab.evaluate(state)), { cookie: "", ls: null });
    await tab.goto(B);
    assert.deepEqual(JSON.parse(await tab.evaluate(state)), { cookie: "sid=1", ls: "v" });
    await tab.resetOrigin(B);
  } finally { await tab.close(); }
});

test("resetOrigin refuses non-http origins", async () => {
  const tab = await Tab.open();
  try { await assert.rejects(tab.resetOrigin("about:blank"), /http/); } finally { await tab.close(); }
});

test("resetOrigin removes parent-domain cookies at every path while preserving other sites", async () => {
  const tab = await Tab.open();
  const origin = 'http://child.example.test';
  const cookies = [
    { name: 'child_root', value: '1', domain: 'child.example.test', path: '/' },
    { name: 'child_path', value: '1', domain: 'child.example.test', path: '/private' },
    { name: 'parent_root', value: '1', domain: '.example.test', path: '/' },
    { name: 'parent_path', value: '1', domain: '.example.test', path: '/private' },
    { name: 'parent_host_only', value: '1', domain: 'example.test', path: '/' },
    { name: 'sibling', value: '1', domain: 'sibling.example.test', path: '/' },
    { name: 'unrelated', value: '1', domain: 'unrelated.test', path: '/' },
  ];
  const named = async () => (await tab.cdp.send('Storage.getCookies')).cookies.filter((cookie) => cookies.some((seeded) => seeded.name === cookie.name));
  try {
    await tab.cdp.send('Network.setCookies', { cookies });
    // Native clearing handles host paths; it leaves parent-domain cookies for explicit deletion.
    await tab.cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    assert.deepEqual((await named()).map((cookie) => cookie.name).sort(), ['parent_host_only', 'parent_path', 'parent_root', 'sibling', 'unrelated']);
    await tab.cdp.send('Network.setCookies', { cookies });
    const result = await tab.resetOrigin(origin);
    assert.equal(result.cookies_deleted, 4);
    assert.deepEqual((await named()).map((cookie) => cookie.name).sort(), ['parent_host_only', 'sibling', 'unrelated']);
  } finally {
    for (const cookie of await named()) await tab.cdp.send('Network.deleteCookies', { name: cookie.name, domain: cookie.domain, path: cookie.path });
    await tab.close();
  }
});
