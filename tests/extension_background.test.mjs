// The service worker's trust boundaries (extension/background.js), run against a mocked chrome.*:
// the bridge handshake, tab ownership and who may change settings.
// Run: node --test tests/extension_background.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const TOKEN = 'test-token';
const EXT_ID = 'a'.repeat(32);
const proof = (label, nonce) => createHmac('sha256', TOKEN).update(`${label}:${nonce}`).digest('hex');
const tick = () => new Promise((r) => setTimeout(r, 20));

function load() {
  const local = { token: TOKEN }, session = {}, removed = [], listeners = {};
  const tabs = [0, 1, 5, 6, 7, 8, 9].map((id) => ({ id, url: `https://example.test/${id}`, title: `Tab ${id}`, active: id === 1 }));
  const event = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const area = (store) => ({
    get: async (keys) => {
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]));
      return { ...keys, ...Object.fromEntries(Object.keys(keys || {}).filter((k) => k in store).map((k) => [k, store[k]])) };
    },
    set: async (o) => { Object.assign(store, o); },
    setAccessLevel: async () => {},
  });
  const sockets = [];
  class FakeWebSocket {
    static OPEN = 1; static CONNECTING = 0;
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; this.closed = false; this.listeners = {}; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.closed = true; this.readyState = 3; this.onclose?.(); (this.listeners.close || []).forEach((f) => f()); }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  }
  const unref = (f) => (...a) => { const t = f(...a); t.unref?.(); return t; };
  const chrome = {
    runtime: { id: EXT_ID, getManifest: () => ({ name: 'Sidecar Monkey' }), getURL: (p) => `chrome-extension://${EXT_ID}/${p}`,
      sendMessage: async () => {}, onMessage: event('message'), onStartup: event('startup'), onInstalled: event('installed') },
    storage: { local: area(local), session: area(session), onChanged: event('storageChanged') },
    alarms: { create: () => {}, onAlarm: event('alarm') },
    tabs: { onRemoved: event('tabRemoved'), remove: async (id) => { removed.push(id); listeners.tabRemoved?.(id); }, get: async (id) => ({ id }), query: async (filter) => filter?.active ? tabs.filter((t) => t.active) : tabs },
    debugger: { onEvent: event('dbgEvent'), onDetach: event('dbgDetach'), detach: async () => {}, attach: async () => {}, getTargets: async () => [] },
    webNavigation: { onCreatedNavigationTarget: event('navTarget') },
    windows: {}, scripting: {},
  };
  const ctx = { chrome, WebSocket: FakeWebSocket, crypto: globalThis.crypto, TextEncoder, URL, console,
    setTimeout: unref(setTimeout), setInterval: unref(setInterval), clearTimeout, clearInterval };
  ctx.importScripts = (file) => vm.runInContext(readFileSync(new URL(`../extension/${file}`, import.meta.url), 'utf8'), ctx);
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8'), ctx);
  return { sockets, local, session, removed, listeners, chrome };
}

async function connected(env, { bridgeProof } = {}) {
  await tick();
  const ws = env.sockets.at(-1);
  await ws.onopen();
  await ws.onmessage({ data: JSON.stringify({ type: 'command', id: 1, cmd: 'ping', params: {} }) });
  assert.deepEqual(ws.sent, [], 'a command before authentication gets no answer');
  await ws.onmessage({ data: JSON.stringify({ type: 'hello', nonce: 'b'.repeat(32), version: 2 }) });
  const auth = ws.sent.at(-1);
  assert.equal(auth.type, 'auth');
  assert.equal(auth.token, undefined, 'the token itself is never sent');
  assert.equal(auth.proof, proof('client', 'b'.repeat(32)));
  await ws.onmessage({ data: JSON.stringify({ type: 'auth_ok', proof: bridgeProof ?? proof('bridge', auth.nonce) }) });
  return ws;
}

async function command(ws, cmd, params = {}) {
  const id = Math.floor(Math.random() * 1e9);
  const before = ws.sent.length;
  await ws.onmessage({ data: JSON.stringify({ type: 'command', id, cmd, params }) });
  for (let i = 0; i < 50 && ws.sent.length === before; i++) await tick();
  return ws.sent.find((m) => m.id === id);
}

test('commands run only after the bridge proves it holds the token', async () => {
  const ws = await connected(load());
  assert.deepEqual((await command(ws, 'ping')).result, { pong: true });
});

test('a command right behind auth_ok is answered', async () => {
  const env = load();
  await tick();
  const ws = env.sockets.at(-1);
  await ws.onopen();
  await ws.onmessage({ data: JSON.stringify({ type: 'hello', nonce: 'b'.repeat(32), version: 2 }) });
  const auth = ws.sent.at(-1);
  // Delivered without waiting for the auth_ok handler to finish, as a socket would.
  const first = ws.onmessage({ data: JSON.stringify({ type: 'auth_ok', proof: proof('bridge', auth.nonce) }) });
  const second = ws.onmessage({ data: JSON.stringify({ type: 'command', id: 77, cmd: 'ping', params: {} }) });
  await Promise.all([first, second]);
  for (let i = 0; i < 50 && !ws.sent.some((m) => m.id === 77); i++) await tick();
  assert.deepEqual(ws.sent.find((m) => m.id === 77)?.result, { pong: true });
});

test('a server that cannot prove the token gets no commands run', async () => {
  const ws = await connected(load(), { bridgeProof: 'f'.repeat(64) });
  assert.equal(ws.closed, true);
  const sent = ws.sent.length;
  await ws.onmessage({ data: JSON.stringify({ type: 'command', id: 9, cmd: 'ping', params: {} }) });
  await tick();
  assert.equal(ws.sent.length, sent);
});

test('cdp_close refuses a tab no relay opened', async () => {
  const env = load();
  const ws = await connected(env);
  const reply = await command(ws, 'cdp_close', { tabId: 5 });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /not opened by a relay client/);
  assert.deepEqual(env.removed, []);
  env.session.cdpOwnTabs = [6];
  assert.equal((await command(ws, 'cdp_close', { tabId: 6 })).ok, true);
  assert.deepEqual(env.removed, [6]);
});

test('named tabs list their current names and ids', async () => {
  const ws = await connected(load());
  assert.deepEqual((await command(ws, 'list_named_tabs')).result, { ok: true, namedTabs: {} });
  await command(ws, 'name_tab', { tabId: 5, name: 'Research' });
  await command(ws, 'name_tab', { tabId: 5, name: 'Notes' });
  await command(ws, 'name_tab', { tabId: 6, name: 'constructor' });
  assert.deepEqual((await command(ws, 'list_named_tabs')).result, { ok: true, namedTabs: { Notes: 5, constructor: 6 } });
});

test('tab selection preserves aliases, zero ids and the default tab', async () => {
  const ws = await connected(load());
  for (const [params, expected] of [[{}, 1], [{ tab_id: 7 }, 7], [{ tabId: null, tab_id: 8 }, 8], [{ tabId: 0, tab_id: 7 }, 0], [{ tabId: 9, tab_id: 8 }, 9]]) {
    const reply = await command(ws, 'name_tab', { ...params, name: 'target' });
    assert.equal(reply.ok, true);
    assert.equal(reply.result.tabId, expected);
  }
});

test('settings change only from the extension\'s own pages', async () => {
  const env = load();
  const reply = (sender) => new Promise((resolve) => {
    const r = env.listeners.message({ type: 'dtb_set', enabled: false }, sender, resolve);
    if (r !== true) resolve(undefined);
  });
  const fromPage = await reply({ id: EXT_ID, tab: { id: 3 }, url: 'https://example.com/' });
  assert.equal(fromPage.ok, false);
  assert.equal(env.local.enabled, undefined);
  const fromPopup = await reply({ id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup.html` });
  assert.equal(fromPopup.ok, true);
  assert.equal(env.local.enabled, false);
  // The settings page opens in a tab (options_ui.open_in_tab), so its messages carry sender.tab.
  const fromOptions = await reply({ id: EXT_ID, tab: { id: 4 }, url: `chrome-extension://${EXT_ID}/options.html` });
  assert.equal(fromOptions.ok, true);
});

test('missing numeric tab ids fail without closing a matching URL', async () => {
  const env = load(), ws = await connected(env);
  env.chrome.tabs.query = async () => [{ id: 10, url: 'https://example.test/invoice/123', title: 'Invoice' }];
  for (const tabId of [123, '123']) {
    const reply = await command(ws, 'close_tab', { tabId });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /tab.*not found/i);
  }
  assert.deepEqual(env.removed, []);
  assert.equal((await command(ws, 'name_tab', { tabId: 'invoice', name: '123' })).result.tabId, 10);
  assert.equal((await command(ws, 'close_tab', { tabId: '123' })).result.closed, 10, 'numeric aliases remain supported');
  env.chrome.tabs.query = async () => [];
  assert.equal((await command(ws, 'close_tab', { tabId: 123 })).ok, false);
});

for (const setting of ['enabled', 'relayEnabled']) {
  for (const phase of ['attach', 'getTargets']) {
    test(`disabling ${setting} during ${phase} detaches instead of completing attachment`, async () => {
      const env = load(), ws = await connected(env);
      let release, entered;
      const waiting = new Promise((resolve) => { entered = resolve; });
      const detached = [];
      env.chrome.debugger.detach = async ({ tabId }) => { detached.push(tabId); };
      env.chrome.debugger[phase] = () => new Promise((resolve) => { release = () => resolve(phase === 'getTargets' ? [] : undefined); entered(); });
      const reply = command(ws, 'cdp_attach', { tabId: 5 });
      await waiting;
      env.local[setting] = false;
      release();
      assert.equal((await reply).ok, false);
      assert.ok(detached.includes(5));
      env.local[setting] = true;
      assert.equal((await command(ws, 'cdp_send', { tabId: 5, method: 'Page.enable' })).ok, false, 'failed attachment is no longer tracked');
    });
  }
}

test('a popup of an attached tab is reported to its relay client and owned by it, other new tabs are not', async () => {
  const env = load(), ws = await connected(env);
  env.session.cdpOwnTabs = [5];
  assert.equal((await command(ws, 'cdp_attach', { tabId: 5 })).ok, true);
  env.listeners.navTarget({ sourceTabId: 5, tabId: 42 });
  env.listeners.navTarget({ sourceTabId: 6, tabId: 43 });
  assert.deepEqual(ws.sent.filter((m) => m.type === 'event'), [{ type: 'event', tabId: 5, method: 'dtb.tabOpened', params: { tabId: 42 } }]);
  // Chrome's openerTabId names the active tab (1) for a background tab's popup; the real source wins.
  env.chrome.tabs.get = async (id) => ({ id, openerTabId: 1 });
  assert.equal((await command(ws, 'cdp_attach', { tabId: 42, own: true })).result.owned, true);
  assert.equal((await command(ws, 'cdp_attach', { tabId: 9, own: true })).result.owned, false);
});

test('transferred tab names survive renaming and closing their previous owner', async () => {
  const env = load(), ws = await connected(env);
  await command(ws, 'name_tab', { tabId: 5, name: 'Report' });
  await command(ws, 'name_tab', { tabId: 6, name: 'Report' });
  await command(ws, 'name_tab', { tabId: 5, name: 'Archive' });
  assert.equal((await command(ws, 'list_named_tabs')).result.namedTabs.Report, 6);
  await command(ws, 'close_tab', { tabId: 5 });
  assert.equal((await command(ws, 'list_named_tabs')).result.namedTabs.Report, 6);
  env.chrome.tabs.create = async () => ({ id: 9 });
  await command(ws, 'create_tab', { name: 'Report' });
  await command(ws, 'close_tab', { tabId: 6 });
  assert.equal((await command(ws, 'list_named_tabs')).result.namedTabs.Report, 9);
});

test('explicit attachment waits for a concurrent open without detaching its tab', async () => {
  const env = load(), ws = await connected(env);
  env.session.cdpOwnTabs = [5];
  let release, entered, attachCalls = 0;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const detached = [];
  env.chrome.debugger.detach = async ({ tabId }) => { detached.push(tabId); };
  env.chrome.debugger.attach = () => {
    attachCalls++;
    if (attachCalls > 1) return Promise.reject(new Error('already attached'));
    entered();
    return new Promise((resolve) => { release = resolve; });
  };
  const opened = command(ws, 'cdp_open', { url: 'https://example.test/5' });
  await waiting;
  const attached = command(ws, 'cdp_attach', { tabId: 5 });
  await tick();
  assert.equal(attachCalls, 1);
  release();
  assert.equal((await opened).ok, true);
  assert.equal((await attached).ok, false);
  assert.deepEqual(detached, []);
});

test('closing by name closes that tab, and a close without a target never falls back to the active tab', async () => {
  const env = load(), ws = await connected(env);
  await command(ws, 'name_tab', { tabId: 7, name: 'scratch' });
  const reply = await command(ws, 'remove_tab', { name: 'scratch' });
  assert.deepEqual([reply.result.closed, reply.result.name], [7, 'scratch']);
  for (const params of [{}, { name: 'unknown' }]) assert.equal((await command(ws, 'remove_tab', params)).ok, false);
  assert.equal((await command(ws, 'close_tab', {})).ok, false);
  assert.deepEqual(env.removed, [7], 'the active tab 1 stayed open');
});

test('a name whose tab already closed never falls through to a URL or title match', async () => {
  const env = load(), ws = await connected(env);
  await command(ws, 'name_tab', { tabId: 7, name: 'invoice' });
  // Tab 7 is gone, but tabs.onRemoved has not run yet; another tab's URL contains the name.
  env.chrome.tabs.query = async () => [{ id: 10, url: 'https://example.test/invoice/42', title: 'Invoice 42', active: true }];
  assert.equal((await command(ws, 'remove_tab', { name: 'invoice' })).ok, false);
  assert.deepEqual(env.removed, []);
});
