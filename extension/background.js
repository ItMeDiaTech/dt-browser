// Sidecar Monkey — background service worker.
// Owns the WebSocket connection to the local bridge and dispatches bridge
// commands to tabs / content scripts. Chrome keeps the SW alive while the
// WebSocket carries a message at least every 30 s (Chrome 116+): see the keepalive.
importScripts('settings.js');
const MAX_UPLOAD_FILES = 24;
const MAX_UPLOAD_FILE_BYTES = 12 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 64 * 1024 * 1024;
const UPLOAD_FETCH_TIMEOUT_MS = 30000;

const MAX_RESPONSE_BYTES = 15 * 1024 * 1024; // under the bridge's 16 MiB frame cap, leaving room for framing

// storage.local (which holds the bridge token) is readable by content scripts by default, and
// content.js runs in every page's renderer: keep it to the extension's own pages.
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

let ws = null;
let reconnectTimer = null;
let status = 'disconnected';
let bridgeUrl = dtbBridgeUrl(DTB_DEFAULTS); // refreshed by every getState(), which precedes each connect()
// Set on auth_fail: the token is wrong, so retrying every 2s would just spam
// the bridge. Only a token change (or extension reload) clears it.
let authFailed = false;

async function getState() {
  const s = await dtbLoad();
  bridgeUrl = dtbBridgeUrl(s);
  return s;
}

// conn (session storage) carries what the popup and options page show beside the status:
// the URL in use, when the current state began, and why the last attempt failed.
function setStatus(st, error) {
  const changed = st !== status;
  status = st;
  chrome.storage.local.set({ status: st }).catch(() => {});
  chrome.storage.session.get({ conn: null }).then(({ conn }) => {
    const since = changed || !conn || conn.url !== bridgeUrl ? Date.now() : conn.since;
    const keepError = st === 'connecting' && conn ? conn.error : null;
    return chrome.storage.session.set({ conn: { status: st, url: bridgeUrl, since, error: error || keepError || null } });
  }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'dtb_status', status: st }).catch(() => {});
}

// Never produce an empty error string (observed: "browser command 'X' failed: ")
function errText(err) {
  if (err == null) return 'unknown error';
  if (typeof err === 'string') return err || 'unknown error';
  const msg = err && err.message;
  if (msg) return String(msg);
  try { return JSON.stringify(err); } catch (e) { return String(err); }
}

// HMAC-SHA256(token, message) as hex: the bridge's proof format (bridge.py `proof`). Empty with no
// token (a --no-auth development bridge): WebCrypto refuses a zero-length HMAC key.
async function hmacHex(token, message) {
  if (!token) return '';
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Exact only when it matters: a string can take at most 3 UTF-8 bytes per UTF-16 unit.
function utf8Length(s) {
  return s.length * 3 <= MAX_RESPONSE_BYTES ? s.length : new TextEncoder().encode(s).length;
}

function connect() {
  if (authFailed) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  setStatus('connecting');
  let sock;
  try {
    sock = new WebSocket(bridgeUrl);
  } catch (e) {
    setStatus('disconnected', `Cannot open ${bridgeUrl}: ${errText(e)}`);
    scheduleReconnect();
    return;
  }
  let opened = false;
  ws = sock; // ownership: every handler below checks `ws === sock` so a stale
  // socket can never clobber the state of a newer one (close+reconnect races).
  sock.onopen = async () => {
    if (ws !== sock) return;
    opened = true;
    const s = await getState();
    if (!s.enabled) {
      ws = null;
      setStatus('disabled');
      sock.close();
      return;
    }
    // Nothing more until the bridge's hello: the token is never sent, only proofs over nonces.
  };
  // Commands are obeyed only after the bridge has proved it holds the token: anything else
  // listening on this port (the bridge being down) gets neither the token nor control.
  let authed = false, mine = '', expected = null, keepalive = null;
  sock.onmessage = async (ev) => {
    if (ws !== sock) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'hello' && !mine && typeof msg.nonce === 'string') {
      const token = (await getState()).token || '';
      mine = randomHex(16);
      // The bridge's answer is known in advance: checking it needs no await when auth_ok arrives,
      // so a command the bridge sends right behind it already finds authed set.
      expected = await hmacHex(token, `bridge:${mine}`);
      const proof = await hmacHex(token, `client:${msg.nonce}`);
      if (ws === sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'auth', proof, nonce: mine, extension: 'dt-browser', version: 2 }));
    } else if (msg.type === 'auth_ok' && expected !== null && !authed) {
      if (typeof msg.proof !== 'string' || msg.proof !== expected) {
        authFailed = true; // not our bridge: never retry into it until settings change
        setStatus('error', `The server at ${bridgeUrl} could not prove it holds the bridge token, so nothing was sent to it.`);
        sock.close();
        return;
      }
      authed = true;
      authFailed = false;
      setStatus('connected');
      // Chrome suspends a service worker whose WebSocket carries no message for 30 s.
      keepalive = setInterval(() => { if (ws === sock && sock.readyState === WebSocket.OPEN) sock.send('{"type":"keepalive"}'); }, 20000);
      sock.addEventListener('close', () => clearInterval(keepalive));
    } else if (msg.type === 'auth_fail') {
      authFailed = true; // wrong token — stop retrying; popup shows 'error' until a token change
      setStatus('error', 'The bridge rejected the token. Paste the one from bridge\\token.txt.');
      sock.close();
    } else if (msg.type === 'command' && msg.id != null && authed) {
      const started = Date.now();
      let logLevel = 'off';
      getState()
        .then((s) => {
          logLevel = s.logLevel;
          if (!s.enabled) throw new Error(`browser control is disabled in the ${DTB_NAME} popup`);
          return handleCommand(msg, s);
        })
        .then((res) => {
          const body = JSON.stringify({ type: 'response', id: msg.id, ok: true, result: res });
          // The bridge drops a connection on a frame over its 16 MiB cap, taking every client
          // with it: answer this one command with an error instead.
          if (utf8Length(body) > MAX_RESPONSE_BYTES) throw new Error(`the result of ${msg.cmd} is ${Math.round(utf8Length(body) / 1048576)} MiB, over the bridge's ${MAX_RESPONSE_BYTES / 1048576} MiB limit; ask for less (a smaller region, fewer elements)`);
          logActivity(logLevel, msg, started, null);
          if (ws === sock && sock.readyState === WebSocket.OPEN) sock.send(body);
        })
        .catch((err) => {
          logActivity(logLevel, msg, started, errText(err));
          if (ws === sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'response', id: msg.id, ok: false, error: errText(err) }));
        });
    }
  };
  sock.onclose = () => {
    if (ws !== sock) return; // a newer socket owns the slot
    ws = null;
    detachAll();
    if (authFailed) return; // keep the auth-error status visible; no reconnect loop
    if (status !== 'disabled') setStatus('disconnected', opened ? 'The bridge closed the connection.' : `No bridge is listening at ${bridgeUrl}.`);
    scheduleReconnect();
  };
  sock.onerror = () => {};
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    if (authFailed) return;
    const s = await getState();
    if (s.enabled) connect();
  }, 2000);
}

// Settings changed (token/enabled): drop the auth-failed flag, close whatever
// socket exists, and reconnect once. Single path used by popup + storage events.
async function reconnectAfterSettings() {
  authFailed = false;
  clearTimeout(reconnectTimer);
  const sock = ws;
  ws = null;
  detachAll();
  if (sock) sock.close();
  const s = await getState();
  if (!s.enabled) {
    setStatus('disabled');
    return;
  }
  connect();
}

// MV3 service workers are suspended after ~30s idle. A chrome.alarms firing
// every 30s wakes the SW so it can (re)connect — the keepalive loop that makes
// the extension self-healing after suspension or bridge restarts.
chrome.alarms.create('dtb-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'dtb-keepalive') return;
  getState().then((s) => {
    if (s.enabled && !authFailed && !(ws && ws.readyState === WebSocket.OPEN)) connect();
  });
});

// ---- main-world eval (runs via chrome.scripting.executeScript, world MAIN) ----
// Serialized by Chrome (not string-eval), so the extension CSP does not apply;
// eval/new Function inside runs under the PAGE's CSP (pages without a strict
// CSP allow it; strict-CSP pages get an explicit error and DOM tools still work).
function mainWorldEval(js) {
  return (async () => {
    let fn;
    try { fn = new Function('return (' + js + ')'); }
    catch (e) { fn = new Function('return (async () => { ' + js + ' })();'); }
    return await fn();
  })().then(
    (v) => { try { return { __dtb_ok: true, value: JSON.parse(JSON.stringify(v)) }; } catch (e) { return { __dtb_ok: true, value: String(v) }; } },
    (e) => ({ __dtb_ok: false, error: String(e && e.message || e) })
  );
}

// ---- activity log ------------------------------------------------------------
// Recent commands, newest last, for the options page. Kept in memory and flushed to session
// storage (cleared when Chrome exits) at most twice a second: cdp_send can run hundreds of
// times a minute. 'commands' skips cdp_send; 'all' records it with its CDP method.
const ACTIVITY_MAX = 200;
let activity = null;
let activityLoad = null; // one load shared by commands that finish before it resolves
let activityFlush = null;

async function logActivity(level, msg, started, error) {
  if (level === 'off' || (msg.cmd === 'cdp_send' && level !== 'all')) return;
  if (!activity) {
    const loaded = await (activityLoad ||= chrome.storage.session.get({ activity: [] }).then((r) => r.activity));
    activity ||= loaded; // a Clear log that ran meanwhile wins
  }
  const p = msg.params || {};
  activity.push({
    t: started, cmd: msg.cmd, ms: Date.now() - started, ok: !error,
    ...(error ? { error: error.slice(0, 300) } : {}),
    ...(Number.isInteger(p.tabId) ? { tabId: p.tabId } : {}),
    ...(msg.cmd === 'cdp_send' && typeof p.method === 'string' ? { method: p.method } : {}),
  });
  if (activity.length > ACTIVITY_MAX) activity.splice(0, activity.length - ACTIVITY_MAX);
  if (!activityFlush) {
    activityFlush = setTimeout(() => {
      activityFlush = null;
      chrome.storage.session.set({ activity }).catch(() => {});
    }, 500);
  }
}

// ---- raw CDP for relay clients (jev-harness) ------------------------------
// chrome.debugger gives relay clients the same DevTools Protocol a dedicated
// Chrome exposes on --remote-debugging-port, but on this (real) profile.
// Events stream to the bridge, which routes them to the relay that owns the tab.
const debuggees = new Set();

function sendEvent(tabId, sessionId, method, params) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'event', tabId, sessionId, method, params }));
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (debuggees.has(source.tabId)) sendEvent(source.tabId, source.sessionId, method, params);
});

// Tab closed, or the user pressed "Cancel" on Chrome's debugging banner.
chrome.debugger.onDetach.addListener((source, reason) => {
  if (debuggees.delete(source.tabId)) sendEvent(source.tabId, undefined, 'Inspector.detached', { reason });
});

// A bridge that went away cannot route events; leave no tab under the debugging banner.
// notify: the bridge is still there (the relay was switched off), so tell each tab's relay.
function detachAll(notify = false) {
  for (const tabId of debuggees) {
    chrome.debugger.detach({ tabId }).catch(() => {});
    if (notify) sendEvent(tabId, undefined, 'Inspector.detached', { reason: 'relay_disabled' });
  }
  debuggees.clear();
}

function cdpTabId(p) {
  if (!Number.isInteger(p.tabId)) throw new Error('tabId (integer) is required');
  return p.tabId;
}

// Tabs relay clients opened themselves (or that their pages opened), oldest first: later runs
// reuse them instead of opening more. Session storage survives a service-worker restart.
async function ownTabs() {
  return (await chrome.storage.session.get({ cdpOwnTabs: [] })).cdpOwnTabs;
}
// Read-modify-writes of the list run one at a time, or a tab closing and one opening at once
// (browse_many) can write back a list that has lost the new tab.
let ownTabsQueue = Promise.resolve();
function updateOwnTabs(change) {
  const run = ownTabsQueue.then(async () => chrome.storage.session.set({ cdpOwnTabs: change(await ownTabs()) }));
  ownTabsQueue = run.catch(() => {});
  return run;
}
chrome.tabs.onRemoved.addListener((tabId) => {
  updateOwnTabs((ids) => ids.filter((id) => id !== tabId)).catch(() => {});
});
// A popup of an attached tab (window.open, target=_blank) is a new tab chrome.debugger does not
// follow; its relay client hears of it through the opener and decides whether to attach it.
// tabs' openerTabId names the window's active tab for a link clicked in a background tab, so the
// page that really opened it comes from webNavigation, kept briefly for cdp_attach's own check.
const popupSources = new Map(); // popup tabId -> the tab whose page opened it
chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId }) => {
  popupSources.set(tabId, sourceTabId);
  setTimeout(() => popupSources.delete(tabId), 60000);
  if (debuggees.has(sourceTabId)) sendEvent(sourceTabId, undefined, 'dtb.tabOpened', { tabId });
});

// chrome.debugger.attach can hang (a tab stuck loading); one hung attach must not hold every later
// open in the queue. An attach that lands after its deadline is let go again.
async function debuggerAttach(tabId, timeoutMs) {
  let timer, late = false;
  const attach = chrome.debugger.attach({ tabId }, '1.3');
  attach.then(() => { if (late) chrome.debugger.detach({ tabId }).catch(() => {}); }, () => {});
  try {
    await Promise.race([attach, new Promise((_, reject) => { timer = setTimeout(() => { late = true; reject(new Error(`attaching to tab ${tabId} timed out after ${timeoutMs}ms`)); }, timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

// Screenshot of a tab that is not in front, without moving the operator's focus:
// Page.captureScreenshot over the debugger, borrowing (and giving back) an attach only if the tab
// is not already held by a relay client.
async function captureBackground(tabId) {
  const borrowed = !debuggees.has(tabId);
  if (borrowed) await debuggerAttach(tabId, 15000);
  try {
    const res = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format: 'png' });
    if (!res || !res.data) throw new Error('Page.captureScreenshot returned no image');
    return 'data:image/png;base64,' + res.data;
  } finally {
    if (borrowed) chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

async function cdpAttach(tabId, s, { own = false } = {}) {
  if (debuggees.has(tabId)) throw new Error(`tab ${tabId} is already attached`);
  await debuggerAttach(tabId, s.relayAttachTimeoutMs);
  // Tracked at once: a tab closed during the awaits below must still report Inspector.detached.
  debuggees.add(tabId);
  try {
    const current = await dtbLoad();
    if (!current.enabled || !current.relayEnabled) throw new Error(`browser control or the DevTools relay is turned off in ${DTB_NAME} settings`);
    if (own) await updateOwnTabs((ids) => [...ids.filter((id) => id !== tabId), tabId]);
    const target = (await chrome.debugger.getTargets()).find((t) => t.tabId === tabId && t.type === 'page');
    const owned = own || (await ownTabs()).includes(tabId);
    // Settings can change while target discovery or session storage is pending.
    const latest = await dtbLoad();
    if (!latest.enabled || !latest.relayEnabled) throw new Error(`browser control or the DevTools relay is turned off in ${DTB_NAME} settings`);
    return { tabId, targetId: target ? target.id : null, owned };
  } catch (e) {
    debuggees.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
    throw e;
  }
}

const originOf = (u) => { try { return new URL(u).origin; } catch { return null; } };

// A tab for a relay client: one already on the requested site (that exact page first; only tabs
// a client opened unless relayReuseTabs), else the newest tab a client opened before, else a new
// background tab in the user's current window or in a separate relay window (relayNewTabs).
// Tabs attached by anyone are skipped.
async function cdpPick(url, s) {
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  const own = await ownTabs();
  // chrome:// and other extensions' pages refuse a debugger; a discarded tab has no page to attach.
  const free = tabs.filter((t) => !debuggees.has(t.id) && !t.discarded && /^(https?:|about:blank)/.test(t.url || ''));
  const origin = url ? originOf(url) : null;
  // The user's tab on that site only with "Use my open tabs" on, and never the one in front of them.
  const site = origin ? free.filter((t) => originOf(t.url) === origin && (own.includes(t.id) || (s.relayReuseTabs && !t.active))) : [];
  const candidates = [
    site.find((t) => own.includes(t.id) && t.url === url), site.find((t) => own.includes(t.id)), site[0],
    ...own.slice().reverse().map((id) => free.find((t) => t.id === id)),
  ].filter(Boolean);
  // Another debugger (DevTools, another extension) may hold a candidate: try the next one.
  for (const t of new Set(candidates)) {
    try { return { ...(await cdpAttach(t.id, s)), created: false }; } catch {}
  }
  let windowId;
  if (s.relayNewTabs === 'separate') {
    // One relay window, reused while it stays open, so parallel runs don't scatter windows.
    const { relayWindowId } = await chrome.storage.session.get({ relayWindowId: null });
    if (relayWindowId !== null) { try { windowId = (await chrome.windows.get(relayWindowId)).id; } catch {} }
  } else {
    try { windowId = (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id; } catch {}
  }
  let tab;
  if (windowId === undefined) {
    const win = await chrome.windows.create({ url: 'about:blank', focused: false });
    if (s.relayNewTabs === 'separate') await chrome.storage.session.set({ relayWindowId: win.id });
    tab = win.tabs[0];
  } else tab = await chrome.tabs.create({ windowId, url: 'about:blank', active: false });
  try {
    return { ...(await cdpAttach(tab.id, s, { own: true })), created: true };
  } catch (e) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw e;
  }
}

// Concurrent opens (browse_many) must not both pick the same free tab.
let cdpOpenQueue = Promise.resolve();
function cdpOpen(url, s) {
  const run = cdpOpenQueue.then(() => cdpPick(url, s));
  cdpOpenQueue = run.catch(() => {});
  return run;
}

async function cdpDetach(tabId) {
  if (debuggees.delete(tabId)) await chrome.debugger.detach({ tabId }).catch(() => {});
}

// ---- tab naming & resolution -----------------------------------------------
const namedTabs = new Map(); // name -> tabId
const tabNames = new Map();  // tabId -> name

function nameTab(tabId, name) {
  const previous = tabNames.get(tabId);
  if (namedTabs.get(previous) === tabId) namedTabs.delete(previous);
  if (namedTabs.has(name)) tabNames.delete(namedTabs.get(name));
  namedTabs.set(name, tabId);
  tabNames.set(tabId, name);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const name = tabNames.get(tabId);
  if (name) {
    if (namedTabs.get(name) === tabId) namedTabs.delete(name);
    tabNames.delete(tabId);
  }
});

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function resolveTab(target) {
  const allTabs = await chrome.tabs.query({});
  if (!allTabs.length) throw new Error('no tabs available');

  if (target == null || target === '' || target === 'active') {
    const act = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
      || allTabs.find((t) => t.active)
      || allTabs[0];
    return act;
  }

  // Check if target is a named tab
  if (typeof target === 'string' && namedTabs.has(target)) {
    const namedId = namedTabs.get(target);
    const byNamedId = allTabs.find((t) => t.id === namedId);
    if (byNamedId) return byNamedId;
    namedTabs.delete(target);
    tabNames.delete(namedId);
  }

  // Check if numeric or integer string
  if (typeof target === 'number' || (/^\d+$/.test(String(target).trim()))) {
    const numericId = Number(target);
    const byId = allTabs.find((t) => t.id === numericId);
    if (byId) return byId;
    throw new Error(`tab ${target} not found`);
  }

  // Check by URL or title substring
  const q = String(target).trim().toLowerCase();
  const matched = allTabs.filter((t) => 
    (t.url && t.url.toLowerCase().includes(q)) || 
    (t.title && t.title.toLowerCase().includes(q))
  );
  if (matched.length) {
    return matched.find((t) => t.active) || matched[0];
  }

  const tabList = allTabs.map((t) => {
    const n = tabNames.get(t.id);
    return `#${t.id}${n ? ` [${n}]` : ''} "${t.title || 'Untitled'}" (${t.url || ''})`;
  }).slice(0, 6).join('; ');
  throw new Error(`tab not found matching "${target}" (available tabs: ${tabList})`);
}

async function resolveTabId(params) {
  const tab = await resolveTab(params?.tabId ?? params?.tab_id ?? null);
  return tab.id;
}

// Resolves when the tab fires status 'complete' (callers attach this BEFORE the
// navigation/update that triggers the load, so fast/cached pages can't complete
// before the listener exists). No pre-check: reading tabs.get here races the
// pending update and can short-circuit with stale pre-navigation state.
function waitForComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => finish({ loaded: false, reason: 'timeout' }), timeoutMs);
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish({ loaded: true });
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function contentMessage(tabId, cmd, params) {
  try {
    return await withTimeout(
      chrome.tabs.sendMessage(tabId, { type: 'dtb', cmd, params: params || {} }),
      20000
    );
  } catch (e) {
    if (e && /timed out after/.test(e.message || '')) {
      throw new Error('content script did not respond within 20s (page busy or hung)');
    }
    // If receiving end does not exist (e.g. extension was reloaded or tab opened before extension installed),
    // automatically re-inject content.js via scripting API and retry once before failing.
    if (e && /Receiving end does not exist/i.test(e.message || '')) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content.js']
        });
        await new Promise((r) => setTimeout(r, 120));
        return await withTimeout(
          chrome.tabs.sendMessage(tabId, { type: 'dtb', cmd, params: params || {} }),
          20000
        );
      } catch (injectErr) {
        // Fall through to error below if page is restricted (e.g. chrome://)
      }
    }
    throw new Error('page not controllable from extension (' + errText(e) + ') — chrome:// pages, the Web Store, PDF viewer and unloaded tabs cannot be driven');
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out after ' + ms + 'ms')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function readBoundedResponse(response, maxBytes, controller, safeUrl) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error(`upload response body is not streamable: ${safeUrl}`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        try { await reader.cancel(); } catch {}
        throw new Error(`upload file exceeds ${maxBytes} bytes: ${safeUrl}`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

async function tabState(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return { tabId, url: tab.url, title: tab.title, status: tab.status };
}

// ---- command dispatch ------------------------------------------------------

async function handleCommand(msg, s) {
  const cmd = msg.cmd;
  const p = msg.params || {};
  if (String(cmd).startsWith('cdp_') && !s.relayEnabled) throw new Error(`the DevTools relay is turned off in ${DTB_NAME} settings`);
  switch (cmd) {
    case 'ping':
      return { pong: true };

    case 'list_tabs': {
      let tabs = await chrome.tabs.query({});
      if (p.query) {
        const q = String(p.query).toLowerCase();
        tabs = tabs.filter((t) => (t.title && t.title.toLowerCase().includes(q)) || (t.url && t.url.toLowerCase().includes(q)) || (tabNames.get(t.id) && tabNames.get(t.id).toLowerCase().includes(q)));
      }
      return tabs.map((t, idx) => {
        let domain = '';
        try { domain = new URL(t.url).hostname; } catch {}
        const name = tabNames.get(t.id) || null;
        return {
          id: t.id,
          name,
          index: t.index ?? idx,
          windowId: t.windowId,
          openerTabId: t.openerTabId,
          active: t.active,
          pinned: t.pinned,
          title: t.title,
          url: t.url,
          domain,
          summary: `#${t.id}${name ? ` [${name}]` : ''} ${t.active ? '[ACTIVE] ' : ''}${t.title || 'Untitled'} (${domain || t.url})`,
        };
      });
    }

    case 'cdp_open':
      if (p.url !== undefined && typeof p.url !== 'string') throw new Error('cdp_open url must be a string');
      return await cdpOpen(p.url, s);

    case 'cdp_attach': {
      const run = cdpOpenQueue.then(async () => {
        // A client may claim a tab as its own only when its own page opened it (a popup).
        const tabId = cdpTabId(p);
        let own = false;
        if (p.own === true) {
          const tab = await chrome.tabs.get(tabId);
          const opener = popupSources.get(tabId) ?? tab.openerTabId;
          own = opener !== undefined && (await ownTabs()).includes(opener);
        }
        return await cdpAttach(tabId, s, { own });
      });
      cdpOpenQueue = run.catch(() => {});
      return await run;
    }

    case 'cdp_send': {
      const tabId = cdpTabId(p);
      if (!debuggees.has(tabId)) throw new Error(`tab ${tabId} is not attached`);
      if (typeof p.method !== 'string' || !p.method) throw new Error('cdp_send requires method');
      const target = p.sessionId ? { tabId, sessionId: String(p.sessionId) } : { tabId };
      return (await chrome.debugger.sendCommand(target, p.method, p.params || {})) || {};
    }

    case 'cdp_detach': {
      const tabId = cdpTabId(p);
      await cdpDetach(tabId);
      return { detached: tabId };
    }

    case 'cdp_close': {
      const tabId = cdpTabId(p);
      // The user's own tabs are only ever detached, whatever the client asks.
      if (!(await ownTabs()).includes(tabId)) throw new Error(`tab ${tabId} was not opened by a relay client; detach it instead`);
      await cdpDetach(tabId);
      await chrome.tabs.remove(tabId).catch(() => {}); // already closed is fine
      return { closed: tabId };
    }

    case 'open_tab':
    case 'create_tab': {
      const url = p.url || 'about:blank';
      // Off by default: an opened tab must never take the operator's focus. Pass
      // activate:true when a human is meant to look at it.
      const active = p.activate === true;
      const t = await chrome.tabs.create({ url, active });
      if (p.name) nameTab(t.id, p.name);
      return { id: t.id, tabId: t.id, name: p.name || null, title: t.title || '', url: t.url || url, active };
    }

    case 'close_tab':
    case 'remove_tab': {
      // Closing is destructive: never default to the operator's active tab.
      const ref = p.tabId ?? p.tab_id ?? null;
      if (ref == null && !p.name) throw new Error(`${cmd} requires tab_id or name`);
      if (ref == null && !namedTabs.has(p.name)) throw new Error(`no tab named "${p.name}"`);
      // A name resolves by its tab id only: a name whose tab just closed must not fall through to a
      // URL/title substring match on another tab.
      const tid = (await resolveTab(ref ?? namedTabs.get(p.name))).id;
      const name = tabNames.get(tid) || null;
      await chrome.tabs.remove(tid);
      if (name) {
        if (namedTabs.get(name) === tid) namedTabs.delete(name);
        tabNames.delete(tid);
      }
      return { ok: true, closed: tid, tabId: tid, name };
    }

    case 'name_tab': {
      if (!p.name) throw new Error('name_tab requires name');
      const tid = await resolveTabId(p);
      const tab = await chrome.tabs.get(tid);
      nameTab(tid, p.name);
      return { ok: true, named: true, tabId: tid, name: p.name, title: tab.title || '', url: tab.url || '' };
    }

    case 'list_named_tabs': {
      return { ok: true, namedTabs: Object.fromEntries(namedTabs) };
    }

    case 'switch_tab': {
      const targetTab = await resolveTab(p.target);
      if (!targetTab) throw new Error(`could not resolve tab "${p.target}"`);
      await chrome.tabs.update(targetTab.id, { active: true });
      if (targetTab.windowId) {
        await chrome.windows.update(targetTab.windowId, { focused: true });
      }
      const name = tabNames.get(targetTab.id) || null;
      return {
        ok: true,
        switched: true,
        tabId: targetTab.id,
        name,
        tabTitle: targetTab.title || '',
        tabUrl: targetTab.url || '',
      };
    }

    case 'activate_tab': {
      const tid = await resolveTabId(p);
      const tab = await chrome.tabs.get(tid);
      await chrome.tabs.update(tid, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { id: tid, title: tab.title, url: tab.url };
    }

    case 'navigate': {
      if (!p.url) throw new Error('navigate requires url');
      const tid = await resolveTabId(p);
      // attach the waiter BEFORE the update so fast/cached pages can't win the race
      const w = p.wait_load !== false ? waitForComplete(tid, 30000) : null;
      await chrome.tabs.update(tid, { url: p.url });
      if (w) {
        const r = await w;
        if (!r.loaded) await new Promise((res) => setTimeout(res, 1500)); // PDF/download/streaming pages may never fire complete
      }
      return await tabState(tid);
    }

    case 'back': {
      const tid = await resolveTabId(p);
      const w = waitForComplete(tid, 10000);
      await chrome.tabs.goBack(tid);
      await w;
      return await tabState(tid);
    }

    case 'forward': {
      const tid = await resolveTabId(p);
      const w = waitForComplete(tid, 10000);
      await chrome.tabs.goForward(tid);
      await w;
      return await tabState(tid);
    }

    case 'reload': {
      const tid = await resolveTabId(p);
      const w = waitForComplete(tid, 20000);
      await chrome.tabs.reload(tid);
      await w;
      return await tabState(tid);
    }

    case 'get_state': {
      const tid = await resolveTabId(p);
      try {
        const cs = await contentMessage(tid, 'get_state', {});
        return Object.assign(await tabState(tid), cs);
      } catch (e) {
        return await tabState(tid); // url/title still available
      }
    }

    case 'eval': {
      const tid = await resolveTabId(p);
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tid },
          world: 'MAIN',
          func: mainWorldEval,
          args: [String(p.js || '')],
        });
        const v = res && res.result;
        if (v && v.__dtb_ok) return { ok: true, result: v.value };
        return { ok: false, error: (v && v.error) || 'eval returned no result' };
      } catch (e) {
        throw new Error('eval failed: ' + errText(e));
      }
    }

    case 'upload_files': {
      const tid = await resolveTabId(p);
      if (!Array.isArray(p.files)) throw new Error('upload_files requires a files array');
      const files = p.files.map((f) => ({
        name: String(f.name || ''),
        url: String(f.url || ''),
        type: String(f.type || ''),
      }));
      if (!files.length || files.some((f) => !f.name || !f.url)) {
        throw new Error('upload_files needs [{name, url, type?}]');
      }
      if (files.length > MAX_UPLOAD_FILES) throw new Error(`upload_files accepts at most ${MAX_UPLOAD_FILES} files`);
      if (files.some((f) => f.name.length > 255 || f.type.length > 255)) {
        throw new Error('upload file names and MIME types must be at most 255 characters');
      }
      // Fetch in the SW (extension context: exempt from the page's CSP, and
      // host_permissions cover localhost / <all_urls>), then inject into the
      // page's file input from ISOLATED world via DataTransfer. Bytes travel as
      // base64: chrome.scripting args must be JSON-serializable. ISOLATED (not
      // MAIN) because FB's CSP blocks MAIN-world executeScript ('unsafe-eval'
      // missing); the isolated content-script world is CSP-exempt and shares
      // the DOM, so CL and FB upload handlers both see the assigned files.
      function bufToB64(buf) {
        const bytes = new Uint8Array(buf);
        let bin = '';
        const CH = 0x8000;
        for (let i = 0; i < bytes.length; i += CH) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        }
        return btoa(bin);
      }
      const out = [];
      let totalBytes = 0;
      for (const f of files) {
        let url;
        try { url = new URL(f.url); } catch { throw new Error('upload_files contains an invalid URL'); }
        const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase());
        if (!['http:', 'https:'].includes(url.protocol) || !loopback || url.username || url.password) {
          throw new Error('upload_files only allows direct loopback HTTP(S) URLs without credentials');
        }
        const safeUrl = url.origin + url.pathname;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), UPLOAD_FETCH_TIMEOUT_MS);
        let resp;
        let buffer;
        try {
          resp = await fetch(url.href, { redirect: 'error', signal: controller.signal });
          if (!resp.ok) throw new Error(`fetch failed ${safeUrl}: HTTP ${resp.status}`);
          const declaredBytes = Number(resp.headers.get('content-length'));
          if (Number.isFinite(declaredBytes) && declaredBytes > MAX_UPLOAD_FILE_BYTES) {
            controller.abort();
            throw new Error(`upload file exceeds ${MAX_UPLOAD_FILE_BYTES} bytes: ${safeUrl}`);
          }
          buffer = await readBoundedResponse(resp, MAX_UPLOAD_FILE_BYTES, controller, safeUrl);
        } catch (e) {
          if (/^upload (file exceeds|response body)/.test(e && e.message || '')) throw e;
          const detail = e && e.name === 'AbortError' ? 'timed out' : errText(e);
          throw new Error(`fetch failed ${safeUrl}: ${detail}`);
        } finally {
          clearTimeout(timer);
        }
        totalBytes += buffer.byteLength;
        if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
          throw new Error(`upload batch exceeds ${MAX_UPLOAD_TOTAL_BYTES} bytes`);
        }
        out.push({
          name: f.name,
          type: f.type || resp.headers.get('content-type') || 'application/octet-stream',
          b64: bufToB64(buffer),
        });
      }
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tid },
        world: 'ISOLATED',
        func: (payload) => {
          const input = document.querySelector('input[type=file]');
          if (!input) return { ok: false, error: 'no file input found on page' };
          const dt = new DataTransfer();
          for (const f of payload) {
            const bin = atob(f.b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            dt.items.add(new File([bytes], f.name, { type: f.type }));
          }
          input.files = dt.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, count: dt.files.length };
        },
        args: [out],
      });
      return (res && res.result) || { ok: false, error: 'no result' };
    }

    case 'snapshot':
    case 'click':
    case 'hover':
    case 'select_option':
    case 'type':
    case 'press':
    case 'scroll':
    case 'extract_text':
    case 'export_html':
    case 'get_element_state':
    case 'read':
    case 'wait_for': {
      const tid = await resolveTabId(p);
      const res = await contentMessage(tid, cmd, p);
      if (res && typeof res === 'object') {
        res.tabId = tid;
        const name = tabNames.get(tid);
        if (name) res.tabName = name;
        try {
          const tab = await chrome.tabs.get(tid);
          if (tab) {
            res.tabTitle = tab.title || '';
            res.tabUrl = tab.url || '';
          }
        } catch {}
      }
      return res;
    }

    case 'screenshot': {
      const tid = await resolveTabId(p);
      const tab = await chrome.tabs.get(tid);
      const winId = tab.windowId;
      // A background tab is captured over CDP, never fronted: captureVisibleTab only works on the
      // active tab, and activating one would move the operator's focus.
      // shortcut: a tab that has never painted can refuse Page.captureScreenshot; that is reported
      // as an error rather than answered by fronting the tab, upgrade by keeping a surface alive.
      if (!tab.active) {
        try {
          return { tabId: tid, mime: 'image/png', dataUrl: await captureBackground(tid) };
        } catch (e) {
          throw new Error(`could not capture background tab ${tid} without fronting it: ${errText(e)}`);
        }
      }
      // Reached only for the tab that is already active: no activation, no restore.
      const win = await chrome.windows.get(winId);
      if (win.state === 'minimized') await chrome.windows.update(winId, { state: 'normal' });
      await new Promise((r) => setTimeout(r, 300)); // let the tab paint
      let dataUrl;
      let lastError;
      for (let attempt = 0; attempt < 3 && !dataUrl; attempt++) {
        try {
          dataUrl = await withTimeout(
            chrome.tabs.captureVisibleTab(winId, { format: 'png' }),
            5000
          );
        } catch (e) {
          lastError = e;
          if (attempt === 2) throw new Error('screenshot failed after 3 attempts: ' + errText(lastError));
          await chrome.windows.update(winId, { focused: true });
          // Chrome rate-limits captureVisibleTab; wait beyond the one-second quota window.
          await new Promise((r) => setTimeout(r, 1100));
        }
      }
      return { tabId: tid, mime: 'image/png', dataUrl };
    }

    default:
      throw new Error('unknown command: ' + cmd);
  }
}

// ---- popup / settings plumbing ---------------------------------------------

// Settings and actions come only from this extension's own pages (popup, options), never from a
// content script: a compromised page renderer must not re-enable control or swap the token.
// The settings page opens in a tab, so sender.tab says nothing; a content script's sender.url is the
// web page's, never this extension's own origin.
const fromOwnPage = (sender) => sender.id === chrome.runtime.id && String(sender.url || '').startsWith(chrome.runtime.getURL(''));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if ((msg.type === 'dtb_set' || msg.type === 'dtb_action') && !fromOwnPage(sender)) {
    sendResponse({ ok: false, error: 'settings can only be changed from the extension popup or settings page' });
    return;
  }
  if (msg.type === 'dtb_set') {
    // Only known keys, each validated; a rejected value is reported, never stored.
    const updates = {};
    for (const key of Object.keys(DTB_DEFAULTS)) if (msg[key] !== undefined) updates[key] = msg[key];
    const { values, errors } = dtbValidate(updates);
    const bad = Object.keys(updates).filter((key) => errors[key]);
    if (bad.length) {
      sendResponse({ ok: false, errors: Object.fromEntries(bad.map((key) => [key, errors[key]])) });
      return;
    }
    chrome.storage.local.set(Object.fromEntries(Object.keys(updates).map((key) => [key, values[key]]))).then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: errText(e) })
    );
    return true;
  }
  if (msg.type === 'dtb_action') {
    (async () => {
      if (msg.action === 'new_tab') {
        const t = await chrome.tabs.create({});
        await chrome.tabs.update(t.id, { active: true });
        return { ok: true, id: t.id };
      }
      if (msg.action === 'reconnect') {
        await reconnectAfterSettings();
        return { ok: true };
      }
      if (msg.action === 'clear_activity') {
        activity = [];
        await chrome.storage.session.set({ activity });
        return { ok: true };
      }
      if (msg.action === 'reload') {
        const t = await activeTab();
        await chrome.tabs.reload(t.id);
        return { ok: true };
      }
      return { ok: false, error: 'unknown action' };
    })().then(sendResponse, (e) => sendResponse({ ok: false, error: errText(e) }));
    return true;
  }
  if (msg.type === 'dtb_get_status') {
    sendResponse({ status, wsUrl: bridgeUrl });
    return;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.token || changes.enabled || changes.bridgeHost || changes.bridgePort) {
    reconnectAfterSettings().catch((e) => setStatus('disconnected', errText(e)));
  }
  if (changes.relayEnabled && changes.relayEnabled.newValue === false) detachAll(true);
});

// initial connect when the SW first spins up
getState().then((s) => { if (s.enabled) connect(); });
