// The read/act/session_reset tools: JEV_ALLOWED_ORIGINS binds them as it binds browse, `act`
// resolves an index against the page the caller read, and failure screenshots are capped.
// The act check is live (Chrome + the bench site on :8911).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

process.env.JEV_ALLOWED_ORIGINS = "127.0.0.1";
process.env.JEV_HOME = mkdtempSync(join(tmpdir(), "jev-home-"));
const { act, read, session, sessionReset } = await import("../src/cli.js");
const { Tab } = await import("../src/browser.js");
const { failureShot } = await import("../src/engine.js");

const SITE = process.env.BENCH_SITE || "http://127.0.0.1:8911";

test("read and session_reset refuse a url outside JEV_ALLOWED_ORIGINS before loading it", async () => {
  await assert.rejects(read({ url: "https://example.com/" }), /outside JEV_ALLOWED_ORIGINS/);
  await assert.rejects(sessionReset({ url: "https://example.com/" }), /outside JEV_ALLOWED_ORIGINS/);
  assert.equal(session.tab, null, "no tab was opened");
});

test("act types into the element the caller read, even after the page inserts fields above it", async () => {
  session.tab = await Tab.open();
  try {
    const r = await read({ url: `${SITE}/newsletter.html` });
    const index = Number(r.elements.match(/\[(\d+)\] textbox "Email address/)[1]);
    // The page renumbers: a new field lands first, so a fresh snapshot would shift every index.
    await session.tab.evaluate("document.body.prepend(Object.assign(document.createElement('input'), { id: 'inserted' }))");
    await act({ action: "type", index, text: "ada@example.com" });
    assert.equal(await session.tab.evaluate("document.getElementById('email').value"), "ada@example.com");
    assert.equal(await session.tab.evaluate("document.getElementById('inserted').value"), "");
    // A url outside the allowlist in the live tab stops act too.
    // Simulate a redirect, which bypasses an explicit goto() URL check.
    await session.tab.cdp.send('Page.navigate', { url: 'http://localhost:8911/newsletter.html' });
    await assert.rejects(session.tab.settle(), /outside JEV_ALLOWED_ORIGINS/);
    await assert.rejects(act({ action: "click", index: 1 }), /outside JEV_ALLOWED_ORIGINS/);
  } finally { await session.tab.close(); session.tab = null; }
});

test("failure screenshots keep only the newest 50", async () => {
  const dir = join(process.env.JEV_HOME, "shots");
  const tab = { screenshot: async (path) => { writeFileSync(path, "x"); return path; } };
  for (let i = 0; i < 55; i++) { await failureShot(tab); await new Promise((r) => setTimeout(r, 2)); }
  assert.equal(readdirSync(dir).length, 50);
});

test("a failed screenshot carries its cause, and a transient capture error is retried", async () => {
  // read({screenshot}) used to answer a bare "screenshot failed": the cause is now in `why`.
  const dead = { screenshot: async () => { throw new Error("Page.captureScreenshot: no frames"); } };
  const why = {};
  assert.equal(await failureShot(dead, why), null);
  assert.match(why.reason, /no frames/);

  // The extension opens harness tabs in the background (active:false); a capture can miss a frame.
  let calls = 0;
  const tab = Object.create(Tab.prototype);
  tab.cdp = { send: async (method) => {
    if (method === 'Runtime.evaluate') return { result: { value: 'http://127.0.0.1/' } };
    assert.equal(method, 'Page.captureScreenshot');
    if (++calls < 3) throw new Error("not available right now"); return { data: Buffer.from("jpeg").toString("base64") };
  } };
  assert.equal((await tab.capture()).toString(), "jpeg");
  assert.equal(calls, 3);
  tab.cdp = { send: async (method) => {
    if (method === 'Runtime.evaluate') return { result: { value: 'http://127.0.0.1/' } };
    throw new Error("Only screenshots from surface are allowed.");
  } };
  await assert.rejects(tab.capture(), /captureScreenshot failed 3x: Only screenshots from surface/);
});

test("act reports what changed, refuses to type into a non-field, and read degrades to text without a key", async () => {
  session.tab = await Tab.open();
  const key = process.env.TYPESAFE_API_KEY, envf = process.env.JEV_ENV_FILE;
  try {
    const r = await read({ url: `${SITE}/newsletter.html` });
    const button = Number(r.elements.match(/\[(\d+)\] button/)[1]);
    await assert.rejects(act({ action: "type", index: button, text: "x" }), /is not a text field/);
    const index = Number(r.elements.match(/\[(\d+)\] textbox "Email address/)[1]);
    await session.tab.evaluate("document.body.append(Object.assign(document.createElement('p'), { textContent: 'freshly added line' }))");
    const a = await act({ action: "scroll_down" });
    assert.ok(Array.isArray(a.changes) && a.changes.includes("freshly added line"), JSON.stringify(a.changes));
    assert.equal(typeof a.scroll?.y, "number");
    assert.ok(index > 0);
    delete process.env.TYPESAFE_API_KEY; process.env.JEV_ENV_FILE = join(process.env.JEV_HOME, "missing.env");
    const q = await read({ query: "what is the email field for" });
    assert.match(q.notes[0], /TYPESAFE_API_KEY is not set/);
    assert.ok(q.text.length > 0);
  } finally {
    if (key !== undefined) process.env.TYPESAFE_API_KEY = key;
    if (envf === undefined) delete process.env.JEV_ENV_FILE; else process.env.JEV_ENV_FILE = envf;
    await session.tab.close(); session.tab = null;
  }
});

test("scroll_down moves an inner scroll container when the page itself cannot scroll", async () => {
  session.tab = await Tab.open();
  try {
    await read({ url: `${SITE}/newsletter.html` });
    await session.tab.evaluate(`document.body.innerHTML = '<div id=feed style="height:300px;overflow-y:auto">' + Array.from({ length: 80 }, (_, i) => '<p>item ' + i + '</p>').join('') + '</div>'`);
    await read({});
    const a = await act({ action: "scroll_down" });
    assert.ok(await session.tab.evaluate("document.getElementById('feed').scrollTop") > 0);
    assert.ok(Array.isArray(a.changes) || a.changes === "no visible text change");
  } finally { await session.tab.close(); session.tab = null; }
});

test("goto waits for a page that renders its content after load", async () => {
  session.tab = await Tab.open();
  try {
    await session.tab.goto(`${SITE}/newsletter.html`);
    await session.tab.evaluate("setTimeout(() => document.body.append(Object.assign(document.createElement('p'), { textContent: 'late '.repeat(500) })), 800)");
    await session.tab.rendered();
    assert.ok((await session.tab.evaluate("document.body.innerText.length")) > 2000);
  } finally { await session.tab.close(); session.tab = null; }
});

test("act uploads files, inserts into an editor, presses key combos and waits for text", async () => {
  session.tab = await Tab.open();
  try {
    const r = await read({ url: `${SITE}/upload.html`, screenshot: true });
    assert.ok(existsSync(r.screenshot), "screenshot written");
    const file = Number(r.elements.match(/\[(\d+)\] file "/)[1]);
    const editor = Number(r.elements.match(/\[(\d+)\] textbox "editor"/)[1]);
    const a = join(process.env.JEV_HOME, "a.jpg"), b = join(process.env.JEV_HOME, "b.jpg");
    writeFileSync(a, "x"); writeFileSync(b, "y");
    await assert.rejects(act({ action: "upload", index: file, files: ["relative.jpg"] }), /absolute path/);
    await assert.rejects(act({ action: "upload", index: editor, files: [a] }), /not a file input/);
    const u = await act({ action: "upload", index: file, files: [a, b] });
    assert.ok(u.changes.includes("chosen: a.jpg, b.jpg"), JSON.stringify(u.changes));
    await act({ action: "click", index: editor });
    await act({ action: "insert", text: "select 1;" });
    assert.equal(await session.tab.evaluate("editor.textContent"), "code: select 1;");
    await act({ action: "key", text: "Control+k" });
    assert.equal(await session.tab.evaluate("keys.textContent"), "shortcut ctrl+k");
    await assert.rejects(act({ action: "insert", text: "(stored password)" }), /stored credentials/);
    // The banner appears 1.5 s after load: it may already be in the last read, so check the page.
    const w = await act({ action: "wait_for", text: "upload complete", ms: 5000 });
    assert.match(w.text, /Upload complete/);
    await act({ action: "wait_for", text: "!processing", ms: 1000 }); // already absent: returns at once
    await assert.rejects(act({ action: "wait_for", text: "never shown", ms: 600 }), /timed out/);
  } finally { await session.tab.close(); session.tab = null; }
});

test("origin guards refuse prohibited setup before browser side effects", async () => {
  const savedFetch = globalThis.fetch, savedAttach = Tab.attach;
  let requests = 0;
  globalThis.fetch = async () => { requests++; return { ok: true, json: async () => ({}) }; };
  Tab.attach = async () => { throw new Error('unexpected attach'); };
  try {
    await assert.rejects(Tab.open('https://example.com/'), /outside JEV_ALLOWED_ORIGINS/);
    assert.equal(requests, 0);
  } finally { globalThis.fetch = savedFetch; Tab.attach = savedAttach; }
  const tab = Object.create(Tab.prototype), sent = [];
  tab.cdp = { on() {}, send: async (method, params) => {
    sent.push(method);
    return method === 'Runtime.evaluate' ? { result: { value: params.expression === 'location.href' ? 'https://example.com/' : 0 } } : {};
  } };
  await assert.rejects(tab.setup(), /outside JEV_ALLOWED_ORIGINS/);
  assert.deepEqual(sent, ['Runtime.evaluate']);
});

test("origin guards block redirected page reads and direct input before inspecting DOM", async () => {
  let reads = 0, captures = 0, inputs = 0;
  const location = { href: 'https://example.com/private', hostname: 'example.com' };
  const tab = Object.create(Tab.prototype);
  tab.cdp = { send: async (method, params) => {
    if (method === 'Page.captureScreenshot') { captures++; return { data: '' }; }
    if (method.startsWith('Input.')) { inputs++; return {}; }
    if (method !== 'Runtime.evaluate') throw new Error(`unexpected ${method}`);
    try {
      const value = vm.runInNewContext(params.expression, { location, document: { get body() { reads++; return { innerText: 'private' }; } } });
      return { result: { value } };
    } catch (error) { return { exceptionDetails: { exception: { description: error.message } } }; }
  } };
  assert.equal(await tab.evaluate('location.href'), location.href, 'URL metadata remains available for policy checks');
  await assert.rejects(tab.evaluate('document.body.innerText'), /outside JEV_ALLOWED_ORIGINS/);
  await assert.rejects(tab.capture(), /outside JEV_ALLOWED_ORIGINS/);
  await assert.rejects(tab.insert('secret'), /outside JEV_ALLOWED_ORIGINS/);
  await assert.rejects(tab.key('Enter'), /outside JEV_ALLOWED_ORIGINS/);
  assert.equal(reads, 0);
  assert.equal(captures, 0);
  assert.equal(inputs, 0);
});

test("origin checks fail closed when the live URL cannot be read", async () => {
  let clicks = 0;
  const saved = session.tab;
  session.tab = { cdp: { open: true }, lines: [], evaluate: async () => { throw new Error('disconnected'); },
    pageTargets: async () => new Set(), click: async () => { clicks++; }, adoptPopup: async () => null, settle: async () => {}, observe: async () => ({ url: 'http://127.0.0.1/', lines: [], elements: [] }) };
  try {
    await assert.rejects(act({ action: 'click', index: 1 }), /disconnected/);
    assert.equal(clicks, 0);
  } finally { session.tab = saved; }
});

test("origin guards recheck the live page before screenshot retries", async () => {
  let captures = 0;
  const tab = Object.create(Tab.prototype);
  tab.cdp = { send: async (method) => {
    if (method === 'Runtime.evaluate') return { result: { value: captures ? 'https://example.com/' : 'http://127.0.0.1/' } };
    assert.equal(method, 'Page.captureScreenshot');
    captures++;
    throw new Error('transient capture failure');
  } };
  await assert.rejects(tab.capture(), /outside JEV_ALLOWED_ORIGINS/);
  assert.equal(captures, 1);
});

test("uploads reject directories before invoking the browser", async () => {
  let uploads = 0;
  const saved = session.tab;
  session.tab = { cdp: { open: true }, elements: [{ i: 1, kind: 'file', multiple: true }], lines: [],
    evaluate: async () => 'http://127.0.0.1/', upload: async () => { uploads++; }, settle: async () => {},
    observe: async () => ({ url: 'http://127.0.0.1/', lines: [], elements: [] }) };
  try {
    await assert.rejects(act({ action: 'upload', index: 1, files: [process.env.JEV_HOME] }), /file/);
    assert.equal(uploads, 0);
  } finally { session.tab = saved; }
});

test("origin guards protect upload node lookup after a navigation between CDP calls", async () => {
  let lookups = 0, uploads = 0;
  const tab = Object.create(Tab.prototype);
  tab.targets = [{ session: null, local: 1 }];
  tab.cdp = { send: async (method, params) => {
    if (method === 'DOM.setFileInputFiles') { uploads++; return {}; }
    assert.equal(method, 'Runtime.evaluate');
    if (params.expression === 'location.href') return { result: { value: 'http://127.0.0.1/' } };
    try {
      vm.runInNewContext(params.expression, { location: { href: 'https://example.com/', hostname: 'example.com' },
        window: { get __jev() { lookups++; return [{}]; } } });
      return { result: { objectId: 'new-page-input' } };
    } catch (error) { return { exceptionDetails: { exception: { description: error.message } } }; }
  } };
  await assert.rejects(tab.upload(1, ['C:/fixture.txt']), /outside JEV_ALLOWED_ORIGINS/);
  assert.equal(lookups, 0);
  assert.equal(uploads, 0);
});
