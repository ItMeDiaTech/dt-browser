// Raw Chrome DevTools Protocol over Node's built-in WebSocket: launch/attach a dedicated Chrome,
// snapshot the page into indexed elements, and execute actions with trusted input events.
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.env.JEV_CDP_PORT || 9333);
const HTTP = `http://127.0.0.1:${PORT}`;

export class StalePage extends Error {}

// JEV_ALLOWED_ORIGINS=host1,host2: the run may only act on (and read) these hosts and their subdomains.
const allowedOrigins = (process.env.JEV_ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
export const originOk = (url) => { if (!allowedOrigins.length || url === "about:blank") return true; let h = ""; try { h = new URL(url).hostname; } catch { return false; } return allowedOrigins.some((a) => h === a || h.endsWith(`.${a}`)); };
class OriginBlocked extends Error {}
const PAGE_ALLOWED = `location.href === "about:blank" || ${JSON.stringify(allowedOrigins)}.some(h => location.hostname === h || location.hostname.endsWith('.' + h))`;
const guardedScript = (source) => allowedOrigins.length ? `if (${PAGE_ALLOWED}) { ${source} }` : source;
const guardedExpression = (expression) => allowedOrigins.length && expression !== "location.href" ? `if (!(${PAGE_ALLOWED})) throw new Error(location.href + " is outside JEV_ALLOWED_ORIGINS");\n${expression}` : expression;

const QUIET_MS = 50, QUIET_CAP_MS = 1000, NET_IGNORE_MS = 1500, EXTENSION_WAIT_MS = Number(process.env.JEV_EXTENSION_WAIT_MS ?? 40000);
const RETRY_STATUS = new Set([403, 429, 500, 502, 503, 504]);
// A closed shadow root is invisible to page script (host.shadowRoot is null). Keep a reference as
// attachShadow creates it, in a WeakMap the snapshot reads; the root stays closed to the page itself.
// Installed before any page script (addScriptToEvaluateOnNewDocument, and cross-origin frames are
// held at start until it is in place). Declarative <template shadowrootmode="closed"> is not seen.
const CLOSED_SHADOWS = `(() => { if (window.__jevClosed) return;
  const roots = new WeakMap(); Object.defineProperty(window, '__jevClosed', { value: roots });
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) { const r = attach.call(this, init); if (init?.mode === 'closed') roots.set(this, r); return r; };
})()`;
// Counts content changes (not attributes: CSS animations and carousels rewrite style attributes
// continuously). Installed in every new document and in the current one on attach.
const MUTATIONS = `(() => { if (window.__jevMutObs) return; window.__jevMut = 0;
  window.__jevMutObs = new MutationObserver(() => { window.__jevMut++; });
  window.__jevMutObs.observe(document, { subtree: true, childList: true, characterData: true }); })()`;

// JEV_BRIDGE=1 (or a ws:// URL): drive the user's own Chrome, through dt-browser's extension and bridge,
// instead of launching a dedicated one. The extension carries the same CDP over chrome.debugger, so
// everything below the transport is unchanged. The page runs with the real profile's logins.
const DEFAULT_BRIDGE = "ws://127.0.0.1:18765";
const BRIDGE = process.env.JEV_BRIDGE ? (/^wss?:/.test(process.env.JEV_BRIDGE) ? process.env.JEV_BRIDGE : DEFAULT_BRIDGE) : null;
export const bridged = !!BRIDGE;
// Run from the dt-browser checkout, the bridge sits beside this folder. Installed with `npm install -g`,
// nothing does: JEV_BRIDGE_DIR / JEV_BRIDGE_TOKEN_FILE (or DT_BRIDGE_TOKEN) must say where it is.
export const CHECKOUT = fileURLToPath(new URL("../../", import.meta.url));
export const IN_CHECKOUT = existsSync(join(CHECKOUT, "bridge", "bridge.py"));
const BRIDGE_DIR = process.env.JEV_BRIDGE_DIR || (IN_CHECKOUT ? join(CHECKOUT, "bridge") : null);

// The bridge's own token precedence: DT_BRIDGE_TOKEN, then its token file (JEV_BRIDGE_TOKEN_FILE, or the
// bridge folder's token.txt).
function bridgeToken() {
  if (process.env.DT_BRIDGE_TOKEN) return process.env.DT_BRIDGE_TOKEN.trim();
  const file = process.env.JEV_BRIDGE_TOKEN_FILE || (BRIDGE_DIR && join(BRIDGE_DIR, "token.txt"));
  if (!file) throw new Error("no bridge token: set DT_BRIDGE_TOKEN, JEV_BRIDGE_TOKEN_FILE or JEV_BRIDGE_DIR (jev-harness is not running from a dt-browser checkout)");
  try { return readFileSync(file, "utf8").trim(); } catch { return ""; }
}

/** HMAC-SHA256(token, "<label>:<nonce>") as hex, the bridge's proof format (bridge.py `proof`); empty with no token. */
export const proof = (token, label, nonce) => !token ? "" : createHmac("sha256", token).update(`${label}:${nonce}`).digest("hex");

// One authenticated relay connection per process, shared by every tab. Responses match by id;
// CDP events arrive tagged with their tab and go to that tab's BridgeCDP.
class Bridge {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.tabs = new Map();
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "event") return this.tabs.get(msg.tabId)?.event(msg);
      const p = msg.type === "response" && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
    };
    ws.onclose = () => {
      for (const { reject } of this.pending.values()) reject(new Error("dt-browser bridge connection closed"));
      this.pending.clear();
      for (const t of this.tabs.values()) t.closed = true;
      this.tabs.clear();
    };
  }
  // The bridge's handshake: answer its nonce with HMAC(token), then check its HMAC over ours, so the
  // token never goes on the wire and a process squatting on the port is not mistaken for the bridge.
  static connect() {
    return new Promise((resolve, reject) => {
      const token = bridgeToken(), ws = new WebSocket(BRIDGE), mine = randomBytes(16).toString("hex");
      let done = false;
      const fail = (why) => { if (done) return; done = true; clearTimeout(timer); try { ws.close(); } catch {} reject(new Error(`dt-browser bridge ${why} (${BRIDGE}): start it with bridge\\start_bridge.cmd --no-lifecycle and check the extension popup shows connected`)); };
      // An open socket that never answers would otherwise hang every queued tool call.
      const timer = setTimeout(() => fail("did not complete the handshake within 5 s"), 5000);
      ws.onerror = () => fail("not reachable");
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return fail("sent something that is not JSON"); }
        if (m?.type === "hello" && typeof m.nonce === "string") return ws.send(JSON.stringify({ type: "auth", proof: proof(token, "client", m.nonce), nonce: mine, client: "relay" }));
        if (m?.type !== "auth_ok") return fail(`refused the connection: ${m?.reason ?? "no hello (an older bridge?)"}`);
        if (typeof m.proof !== "string" || m.proof !== proof(token, "bridge", mine)) return fail("could not prove it holds the bridge token");
        done = true; clearTimeout(timer); resolve(new Bridge(ws));
      };
    });
  }
  get open() { return this.ws.readyState === WebSocket.OPEN; }
  // The extension's service worker reconnects on a 30 s alarm, so "no browser connected" is usually
  // a gap of seconds, not an outage: wait it out (up to 40 s) instead of failing the tool call.
  async command(cmd, params = {}, timeoutMs = 15000) {
    for (let t0 = Date.now(); ; await sleep(2000)) {
      try { return await this.send(cmd, params, timeoutMs); }
      catch (e) { if (!/no browser connected/.test(e.message) || Date.now() - t0 > EXTENSION_WAIT_MS) throw e; }
    }
  }
  send(cmd, params, timeoutMs) {
    if (!this.open) return Promise.reject(new Error("dt-browser bridge connection closed"));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      // The bridge enforces the same deadline (0.1-120 s); ours fires only if the bridge itself hangs.
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`bridge ${cmd} timed out`)); }, timeoutMs + 2000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ type: "command", id, cmd, params, timeout: Math.min(120, timeoutMs / 1000) }));
    });
  }
}

// No bridge running on the default port: start this checkout's own (detached, so it outlives this
// process; --no-lifecycle keeps it up without Hermes), then wait for it and for the extension, which
// retries its connection every 2 s.
async function connectBridge() {
  try { return await Bridge.connect(); } catch (e) {
    if (BRIDGE !== DEFAULT_BRIDGE || !/not reachable/.test(e.message)) throw e;
    if (!BRIDGE_DIR || !existsSync(join(BRIDGE_DIR, "bridge.py"))) throw new Error(`${e.message}. To start it automatically, set JEV_BRIDGE_DIR to the dt-browser bridge folder`);
  }
  let last = new Error("dt-browser bridge did not start (is uv on PATH?)");
  // Windows: a detached (console-less) uv starting console python.exe gets a fresh visible console
  // window regardless of windowsHide; --gui-script runs pythonw.exe, which has none (logs go to bridge.log).
  const run = process.platform === "win32" ? ["run", "--gui-script", "bridge.py"] : ["run", "python", "bridge.py"];
  spawn("uv", [...run, "--no-lifecycle"], { cwd: BRIDGE_DIR, detached: true, stdio: "ignore", windowsHide: true })
    .on("error", (e) => { last = new Error(`could not start the dt-browser bridge: ${e.message}`); }).unref();
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    let b;
    try { b = await Bridge.connect(); } catch { continue; }
    try { await b.command("ping", {}, 2000); return b; } catch (e) { last = e; b.ws.close(); }
  }
  throw last;
}

let bridgeLink = null;
function bridge() {
  if (bridgeLink) return bridgeLink;
  // Only the current link clears the slot: an old socket closing late must not drop a newer one.
  const p = bridgeLink = connectBridge().then(
    (b) => { b.ws.addEventListener("close", () => { if (bridgeLink === p) bridgeLink = null; }); return b; },
    (e) => { if (bridgeLink === p) bridgeLink = null; throw e; });
  return p;
}
// MCP server start (the client's launch): bring the bridge up now rather than on the first tool call.
export function warmBridge() { if (BRIDGE) bridge().catch(() => {}); }

// An open socket keeps Node running: drop the link once its last tab is closed and nothing is in
// flight, so a one-shot CLI run exits. The next Tab.open reconnects.
function releaseBridge(link) {
  if (link.tabs.size || link.pending.size) return;
  bridgeLink = null;
  link.ws.close();
}
// cdp_open/cdp_attach answer {tabId, targetId, owned, created}: the shape Tab.attach takes. owned: a tab
// the harness opened (it may close it); created: opened by this very call.
const bridgeTarget = (r) => ({ id: r.targetId, tabId: r.tabId, owned: !!r.owned, created: !!r.created });

// The CDP class's interface for one tab attached through the bridge.
class BridgeCDP {
  constructor(link, tabId) { this.link = link; this.tabId = tabId; this.handlers = new Map(); this.closed = false; this.popups = []; link.tabs.set(tabId, this); }
  get open() { return !this.closed && this.link.open; }
  event(msg) {
    // The tab closed, or the user cancelled Chrome's debugging banner.
    if (msg.method === "Inspector.detached") return this.close();
    // The extension names the tabs this page opened (target=_blank, window.open).
    if (msg.method === "dtb.tabOpened") return void this.popups.push(msg.params?.tabId);
    this.handlers.get(msg.method)?.(msg.params, msg.sessionId);
  }
  send(method, params = {}, timeoutMs = 15000, sessionId) {
    if (!this.open) return Promise.reject(new Error("CDP socket closed (tab or Chrome went away)"));
    return this.link.command("cdp_send", sessionId ? { tabId: this.tabId, method, params, sessionId } : { tabId: this.tabId, method, params }, timeoutMs)
      .catch((error) => { throw new Error(`${method}: ${error.message}`, { cause: error }); });
  }
  on(method, fn) { this.handlers.set(method, fn); }
  close() { this.closed = true; this.link.tabs.delete(this.tabId); }
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message}`)) : resolve(msg.result);
      } else if (msg.method) this.handlers.get(msg.method)?.(msg.params, msg.sessionId);
    };
    ws.onclose = () => { for (const { reject } of this.pending.values()) reject(new Error("CDP socket closed")); this.pending.clear(); };
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new CDP(ws));
      ws.onerror = () => reject(new Error(`CDP connect failed: ${url}`));
    });
  }
  get open() { return this.ws.readyState === WebSocket.OPEN; }
  // sessionId addresses a flat-attached child target (a cross-origin frame) over the same socket.
  send(method, params = {}, timeoutMs = 15000, sessionId) {
    if (!this.open) return Promise.reject(new Error("CDP socket closed (tab or Chrome went away)"));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
  on(method, fn) { this.handlers.set(method, fn); }
  close() { try { this.ws.close(); } catch {} }
}

function chromePath() {
  const candidates = [
    process.env.JEV_CHROME,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ];
  const hit = candidates.find((p) => p && existsSync(p));
  if (!hit) throw new Error("Chrome not found; set JEV_CHROME to the browser executable");
  return hit;
}

async function alive() {
  try { return (await fetch(`${HTTP}/json/version`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

// A dedicated profile: Chrome 136+ refuses remote debugging on the default profile, and it keeps
// automation cookies away from the user's real session.
// Chrome's "Save password?" bubble opens after any password-form submission and, while open, swallows
// every mouse event to the page (found on saucedemo: all clicks after a login went nowhere). The
// feature flags do not cover it; the profile preferences do. Written before each launch.
function disablePasswordManager(profile) {
  const file = join(profile, "Default", "Preferences");
  let prefs = {};
  try { prefs = JSON.parse(readFileSync(file, "utf8")); } catch { mkdirSync(join(profile, "Default"), { recursive: true }); }
  prefs.credentials_enable_service = false;
  prefs.profile = { ...prefs.profile, password_manager_enabled: false, password_manager_leak_detection: false };
  writeFileSync(file, JSON.stringify(prefs));
}

function chromeProfile() {
  return process.env.JEV_PROFILE || join(homedir(), ".jev-harness", "chrome-profile");
}

// How long a launch is allowed to be "in progress" before another caller may retry it.
const LAUNCH_LOCK_MS = 20000;

function launchLockAge() {
  try { return Date.now() - statSync(join(chromeProfile(), "jev-launch.lock")).mtimeMs; } catch { return Infinity; }
}

/** One launcher per profile across processes: true when THIS caller should spawn Chrome. */
function takeLaunchLock() {
  if (launchLockAge() < LAUNCH_LOCK_MS) return false;
  try {
    mkdirSync(chromeProfile(), { recursive: true });
    writeFileSync(join(chromeProfile(), "jev-launch.lock"), String(process.pid));
    return true;
  } catch {
    return true; // cannot lock at all: behave as before rather than refusing to start a browser
  }
}

export async function ensureChrome() {
  if (await alive()) return;
  const profile = chromeProfile();
  disablePasswordManager(profile);
  const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,PasswordLeakDetection", "--password-store=basic", "about:blank"];
  if (process.env.JEV_HEADLESS === "1") args.unshift("--headless=new", "--window-size=1280,900");
  // Several MCP servers (one per agent session) call this at once. Every caller that found the
  // port cold used to spawn Chrome; Chrome is already running on this profile, so each extra
  // spawn opens ANOTHER WINDOW and the debugging port never comes up — one night of browser
  // tool calls left ~50 windows. Launch once under a lock; everyone else waits for that one.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (takeLaunchLock()) spawn(chromePath(), args, { detached: true, stdio: "ignore" }).unref();
    for (let i = 0; i < 20; i++) {
      if (await alive()) return;
      await sleep(250);
    }
  }
  throw new Error(`Chrome did not expose CDP on port ${PORT}`);
}

async function pageIds() {
  const list = await (await fetch(`${HTTP}/json/list`)).json();
  return list.filter((t) => t.type === "page");
}

// /json/list has no openerId; the browser-level Target domain does.
async function openedBy(targetId) {
  const { webSocketDebuggerUrl } = await (await fetch(`${HTTP}/json/version`)).json();
  const browser = await CDP.connect(webSocketDebuggerUrl);
  try {
    const { targetInfos } = await browser.send("Target.getTargets");
    return targetInfos.filter((t) => t.type === "page" && t.openerId === targetId).map((t) => t.targetId);
  } finally { browser.close(); }
}

// Page-side snapshot. Stores live nodes in window.__jev so an index maps back to its element;
// a navigation wipes it, which is how stale indices are detected.
const SNAPSHOT = `(() => {
  const SEL = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[contenteditable=""],[contenteditable=true],[onclick]';
  const WRAP = 'a[href],button,[role=button],[role=link]';
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const vh = innerHeight, vw = innerWidth, nodes = [], seen = new Set(), out = [];
  // Open shadow roots and same-origin iframes are walked too (querySelectorAll stops at both);
  // ox/oy shift a frame's rects into the top viewport. Cross-origin frames are snapshotted by the Tab.
  const roots = [];
  const collect = (root, ox, oy) => {
    if (roots.length >= 200) return;
    roots.push({ root, ox, oy });
    for (const h of root.querySelectorAll('*')) {
      const sr = h.shadowRoot || h.ownerDocument.defaultView?.__jevClosed?.get(h);
      if (sr) { if (!h.checkVisibility || h.checkVisibility()) collect(sr, ox, oy); }
      else if (h.tagName === 'IFRAME' || h.tagName === 'FRAME') {
        let d = null; try { d = h.contentDocument; } catch {}
        const b = h.getBoundingClientRect();
        if (d?.body && b.width >= 20 && b.height >= 20 && (!h.checkVisibility || h.checkVisibility())) collect(d, ox + b.left + h.clientLeft, oy + b.top + h.clientTop);
      }
    }
  };
  collect(document, 0, 0);
  const labelOf = (el, editable) => {
    const al = el.getAttribute('aria-label'); if (clean(al)) return clean(al);
    const lb = el.getAttribute('aria-labelledby');
    const scope = el.getRootNode().getElementById ? el.getRootNode() : document;
    if (lb) { const t = clean(lb.split(/\\s+/).map((id) => scope.getElementById(id)?.innerText || '').join(' ')); if (t) return t; }
    // A wrapping <label> also contains the control's own text (select options): strip it.
    if (el.labels?.length) { const own = clean(el.innerText); let t = clean([...el.labels].map((l) => l.innerText).join(' ')); if (own) t = clean(t.replace(own, '')); if (t) return t; }
    if (!editable) { const t = clean(el.innerText); if (t) return t; }
    const t = clean(el.placeholder || el.title || el.alt || el.querySelector?.('img[alt]')?.alt || (editable ? '' : el.value) || el.name || '');
    if (t) return t;
    // Icon-only controls: fall back to the id, then to an icon class name (fa-search -> "search").
    const icon = [...el.querySelectorAll('i,svg,span')].flatMap((c) => [...c.classList]).find((k) => /^(fa|bi|icon|glyphicon|material)[-_]?(.+)/.test(k) && !/^(fa|fas|far|fab|bi|icon)$/.test(k));
    return clean((el.id || '').replace(/[-_]+/g, ' ') || (icon || '').replace(/^(fa|bi|icon|glyphicon|material)[-_]?/, '').replace(/[-_]+/g, ' '));
  };
  walk: for (const { root, ox, oy } of roots) for (const el of root.querySelectorAll(SEL)) {
    const tag = el.tagName.toLowerCase(), type = (el.getAttribute('type') || '').toLowerCase();
    if (el.disabled || (tag === 'input' && type === 'hidden')) continue;
    // File inputs are usually hidden behind a styled button, yet they are the only way to upload.
    const file = tag === 'input' && type === 'file';
    if (!file && el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    let b = el.getBoundingClientRect();
    if (el.editContext && el.parentElement && b.width < 2 && b.height >= 2) b = el.parentElement.getBoundingClientRect();
    if (!file && (b.width < 2 || b.height < 2)) continue;
    const r = { top: b.top + oy, bottom: b.bottom + oy, left: b.left + ox, right: b.right + ox, width: b.width, height: b.height };
    // Off-canvas drawers and aria-hidden subtrees pass checkVisibility but cannot be used: skip them.
    if (!file && el.closest('[aria-hidden="true"]')) continue;
    if (!file && (r.top + scrollY + r.height <= 0 || r.left + scrollX + r.width <= 0 || r.left + scrollX >= document.documentElement.scrollWidth)) continue;
    const wrapper = el.parentElement?.closest(WRAP); if (wrapper && seen.has(wrapper)) continue;
    const inputRole = { checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button', image: 'button', search: 'searchbox', file: 'file' }[type];
    const role = el.getAttribute('role') || { a: 'link', button: 'button', select: 'select', textarea: 'textbox', summary: 'button' }[tag]
      || (tag === 'input' ? inputRole || 'textbox' : el.isContentEditable ? 'textbox' : 'button');
    const editable = el.isContentEditable || (['textbox', 'searchbox', 'combobox'].includes(role) && ['input', 'textarea'].includes(tag)) || (tag === 'input' && !inputRole) || tag === 'textarea';
    const e = { i: nodes.length + 1, role, label: labelOf(el, editable).slice(0, 100) };
    e.kind = file ? 'file' : tag === 'select' ? 'select' : editable ? 'fill' : 'click';
    if (file) { e.label = (e.label || el.getAttribute('accept') || 'file').slice(0, 100); if (el.multiple) e.multiple = true; }
    if (editable) e.value = clean(el.isContentEditable ? el.innerText : el.value).slice(0, 80);
    // A password field is typeable only from stored credentials; its value never leaves the page.
    if (tag === 'input' && type === 'password') { e.kind = 'secret'; e.role = 'password'; e.value = el.value ? '••••' : ''; }
    if (editable && (type === 'search' || role === 'searchbox')) e.search = true;
    if (['checkbox', 'radio'].includes(type)) e.checked = el.checked;
    else if (el.hasAttribute('aria-checked')) e.checked = el.getAttribute('aria-checked') === 'true';
    if (el.hasAttribute('aria-expanded')) e.expanded = el.getAttribute('aria-expanded') === 'true';
    if (tag === 'select') { e.value = clean(el.selectedOptions[0]?.text); e.options = [...el.options].slice(0, 60).map((o) => clean(o.text)); }
    if (!file && (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw)) e.offscreen = true;
    nodes.push(el); seen.add(el); out.push(e);
    if (out.length >= 800) break walk;
  }
  // Duplicate labels ("Add to cart" x6) get the nearest container's own text as context, so the
  // model can tell which product a button belongs to.
  const counts = {}; for (const e of out) counts[e.role + e.label] = (counts[e.role + e.label] || 0) + 1;
  out.forEach((e, k) => {
    // Duplicates, and generic item verbs even when unique ("Remove" once one item is in the cart).
    if (!e.label || (counts[e.role + e.label] < 2 && !/^(add|remove|delete|buy|view|edit|select|details|more|save)(?![a-z])/i.test(e.label))) return;
    let c = nodes[k].parentElement;
    for (let depth = 0; c && depth < 6; depth++, c = c.parentElement) {
      const t = clean(c.innerText); if (t.length <= e.label.length + 5) continue;
      if (t.length > 400) break;
      const hint = c.innerText.split(String.fromCharCode(10)).map(clean).find((x) => x && !e.label.includes(x) && !/^[$]?[0-9][0-9.,]*$/.test(x));
      if (hint) { e.label = e.label + ' — ' + hint.slice(0, 50); break; }
    }
  });
  window.__jev = nodes;
  // Which snapshot the indices belong to: a later reattach keeps them only if no other run has
  // snapshotted this document since.
  window.__jevSnap = Math.random().toString(36).slice(2);
  // innerText skips shadow trees and frame documents: their text follows the page's own.
  const text = [document.body?.innerText || ''];
  for (const { root } of roots.slice(1)) text.push(root.body ? root.body.innerText : [...root.children].filter((c) => !['STYLE', 'SCRIPT', 'TEMPLATE', 'LINK'].includes(c.tagName) && (!c.checkVisibility || c.checkVisibility())).map((c) => c.innerText || '').join('\\n'));
  // innerText lists every <option> of a <select>; only the selected one is on screen. The others read
  // as content ("Price: high to low" right above a list sorted low to high), so they are dropped.
  const hidden = new Set();
  for (const { root } of roots) for (const s of root.querySelectorAll('select')) for (const o of s.options) if (!o.selected) hidden.add(clean(o.text));
  const lines = text.join('\\n').split('\\n').map(clean).filter((l) => l && !hidden.has(l));
  return { url: location.href, title: document.title, snap: window.__jevSnap, lines: lines.slice(0, 1500), elements: out,
    scroll: { y: Math.round(scrollY), max: Math.max(0, document.documentElement.scrollHeight - innerHeight) } };
})()`;

// Cookie/consent banners cost a decision each; clear the obvious ones in code. Accepting is only
// allowed inside cookie/consent containers: an "OK" in a generic modal may confirm something destructive.
const DISMISS = `(() => {
  const accept = /^(accept( all)?( cookies)?|allow all|i agree|agree|got it|ok|okay|reject all|close|dismiss)$/i;
  const close = /^(close|dismiss|no thanks|not now|maybe later|×|✕)$/i;
  const text = (b) => (b.innerText || '').trim(), aria = (b) => b.getAttribute('aria-label') || '';
  const hit = [...document.querySelectorAll('button,[role=button],a')].filter((b) => (!b.checkVisibility || b.checkVisibility()) && (
    (accept.test(text(b)) && b.closest('[class*=cookie i],[id*=cookie i],[class*=consent i],[id*=consent i]'))
    || ((close.test(text(b)) || /^(close|dismiss)/i.test(aria(b))) && b.closest('[class*=cookie i],[id*=cookie i],[class*=consent i],[id*=consent i],[class*=banner i],[role=dialog],[aria-modal=true]'))));
  hit.slice(0, 3).forEach((b) => b.click()); return hit.length; })()`;

const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

export class Tab {
  // In the user's Chrome the extension picks the tab: one already on url's site, else one the harness
  // opened before, else a new background tab in the current window.
  static async open(url) {
    if (url && !originOk(url)) throw new OriginBlocked(`${url} is outside JEV_ALLOWED_ORIGINS`);
    if (BRIDGE) return Tab.attach(bridgeTarget(await (await bridge()).command("cdp_open", url ? { url } : {}, 20000)));
    await ensureChrome();
    const target = await (await fetch(`${HTTP}/json/new?about:blank`, { method: "PUT" })).json();
    return Tab.attach(target);
  }
  static async attach(target) {
    const tab = new Tab();
    tab.targetId = target.id;
    tab.tabId = target.tabId;
    tab.owned = !!target.owned; tab.created = !!target.created;
    tab.cdp = BRIDGE ? new BridgeCDP(await bridge(), target.tabId) : await CDP.connect(target.webSocketDebuggerUrl);
    try { await tab.setup(); } catch (e) {
      // The extension has attached already: let go, or the tab stays under the banner and the
      // link (which still counts it) keeps the process alive.
      if (BRIDGE) await (tab.created ? tab.close() : tab.detach()); else tab.cdp.close();
      throw e;
    }
    return tab;
  }

  async setup() {
    const tab = this;
    await tab.assertAllowed();
    // Background tabs need active-page input acknowledgements without taking the user's focus. It
    // also makes focus events fire at once, so type()'s focus check sees a focus trap before typing.
    await tab.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    tab.dialogs = [];
    tab.cdp.on("Page.javascriptDialogOpening", (p) => {
      // Never auto-confirm: a confirm() may guard a destructive action the goal did not ask for.
      const accept = p.type === "alert" || p.type === "beforeunload";
      tab.dialogs.push(`${p.type} ${accept ? "accepted" : "dismissed"}: ${p.message.slice(0, 100)}`);
      tab.cdp.send("Page.handleJavaScriptDialog", { accept }).catch(() => {});
    });
    // Settling signals: main-frame loading (the main frame id is the target id), in-flight XHR/fetch,
    // and a page-side DOM mutation counter installed in every document.
    tab.loading = false; tab.inflight = new Map();
    tab.cdp.on("Page.frameStartedLoading", (p) => { if (p.frameId === tab.targetId) tab.loading = true; });
    // A click's form POST or link is requested before it starts loading; on a busy machine that gap
    // outlasted quiet()'s first check, which then settled on the old page.
    tab.cdp.on("Page.frameRequestedNavigation", (p) => { if (p.frameId === tab.targetId) tab.loading = true; });
    tab.cdp.on("Page.frameStoppedLoading", (p) => { if (p.frameId === tab.targetId) tab.loading = false; });
    tab.cdp.on("Network.requestWillBeSent", (p) => {
      if (p.type === "XHR" || p.type === "Fetch") tab.inflight.set(p.requestId, Date.now());
      if (p.type === "Document" && p.frameId === tab.targetId) tab.doc = { method: p.request.method, status: 0 };
    });
    tab.cdp.on("Network.responseReceived", (p) => { if (p.type === "Document" && p.frameId === tab.targetId && tab.doc) tab.doc.status = p.response.status; });
    tab.cdp.on("Network.loadingFinished", (p) => tab.inflight.delete(p.requestId));
    tab.cdp.on("Network.loadingFailed", (p) => tab.inflight.delete(p.requestId));
    // Cross-origin iframes (OOPIFs) are separate targets: auto-attach gives one flat session each.
    tab.frames = new Map();
    // A new frame waits (waitForDebuggerOnStart) until its closed-shadow hook is installed and its own
    // children are auto-attached; `parent` is the session it was announced on (undefined: the page).
    tab.cdp.on("Target.attachedToTarget", async (p, parent) => {
      const s = p.sessionId, send = (m, params) => tab.cdp.send(m, params, 15000, s).catch(() => {});
      if (p.targetInfo.type !== "iframe" || !originOk(p.targetInfo.url || "about:blank")) { await send("Runtime.runIfWaitingForDebugger"); tab.cdp.send("Target.detachFromTarget", { sessionId: s }, 15000, parent).catch(() => {}); return; }
      tab.frames.set(s, { targetId: p.targetInfo.targetId, parent });
      try {
        await send("Page.addScriptToEvaluateOnNewDocument", { source: guardedScript(CLOSED_SHADOWS) });
        await send("DOM.enable");
        await send("Target.setAutoAttach", AUTO_ATTACH);
      } finally { await send("Runtime.runIfWaitingForDebugger"); }
    });
    tab.cdp.on("Target.detachedFromTarget", (p) => tab.frames.delete(p.sessionId));
    await tab.cdp.send("Page.enable");
    await tab.cdp.send("Network.enable");
    await tab.cdp.send("DOM.enable");
    await tab.cdp.send("Target.setAutoAttach", AUTO_ATTACH);
    await tab.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: guardedScript(MUTATIONS) });
    await tab.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: guardedScript(CLOSED_SHADOWS) });
    await tab.evaluate(MUTATIONS).catch(() => {});
  }

  async evaluate(expression, session) {
    // Check in the same evaluation as the DOM access: redirects cannot race a prior URL read.
    const r = await this.cdp.send("Runtime.evaluate", { expression: guardedExpression(expression), returnByValue: true, awaitPromise: true }, 15000, session);
    if (r.exceptionDetails) {
      const message = r.exceptionDetails.exception?.description?.split("\n")[0] || "page script error";
      throw message.includes("outside JEV_ALLOWED_ORIGINS") ? new OriginBlocked(message) : new Error(message);
    }
    return r.result.value;
  }

  async assertAllowed(session) {
    const url = await this.evaluate("location.href", session);
    if (!originOk(url)) throw new OriginBlocked(`${url} is outside JEV_ALLOWED_ORIGINS`);
    return url;
  }

  // Wait until the page is quiet instead of sleeping fixed amounts (jev-ultrafast settles on ~50 ms
  // of DOM silence): the document is loaded, no XHR/fetch is in flight, and the DOM has not changed
  // for QUIET_MS. readyState is polled too because SPAs and bfcache restores skip load events.
  async settle(maxMs = 8000) {
    await this.quiet(maxMs);
    // Some sites (eBay search: 403 in 5 of 12 runs) answer a valid GET with a transient error page
    // that one reload clears. Never a POST: reloading it would resubmit the form.
    // Each document is judged once, so a page that stays broken is not reloaded again and again.
    const d = this.doc;
    if (d && !d.handled && d.method === "GET" && RETRY_STATUS.has(d.status)) {
      d.handled = true;
      (this.reloads ??= []).push(`reloaded after HTTP ${d.status}`);
      await sleep(1000);
      await this.cdp.send("Page.reload", {}).catch(() => {});
      await this.quiet(maxMs);
    }
    if (this.doc) this.doc.handled = true;
  }

  async quiet(maxMs) {
    const t0 = Date.now(), end = t0 + maxMs;
    await sleep(40); // a click's navigation or fetch starts asynchronously
    let mutations = null, quietSince = Date.now(), loadedAt = 0;
    while (Date.now() < end) {
      let s = null;
      try { s = await this.evaluate("[document.readyState, window.__jevMut ?? 0]"); } catch (e) { if (e instanceof OriginBlocked) throw e; } // throws mid-navigation
      const now = Date.now();
      // A frameStoppedLoading lost in a navigation race must not hold the run for maxMs.
      const loaded = s?.[0] === "complete" && (!this.loading || now - t0 > 3000);
      if (loaded) loadedAt ||= now; else loadedAt = 0;
      // Requests older than NET_IGNORE_MS are long-polls or beacons, not content.
      const busy = [...this.inflight.values()].some((t) => now - t < NET_IGNORE_MS);
      if (!loaded || busy || s[1] !== mutations) { mutations = s?.[1]; quietSince = now; }
      else if (now - quietSince >= QUIET_MS) return;
      // Tickers and live widgets never stop mutating: give up on silence QUIET_CAP_MS after load.
      if (loadedAt && now - loadedAt >= QUIET_CAP_MS) return;
      await sleep(15);
    }
  }

  async goto(url) {
    if (!originOk(url)) throw new OriginBlocked(`${url} is outside JEV_ALLOWED_ORIGINS`);
    const r = await this.cdp.send("Page.navigate", { url }, 30000);
    // ERR_ABORTED is a navigation replaced by a redirect or a client-side route (GitHub settings): the
    // page still loads, and a retry of the same url always succeeded. Anything else is a real failure.
    if (r.errorText && r.errorText !== "net::ERR_ABORTED") throw new Error(`navigation failed: ${r.errorText}`);
    await this.settle(15000);
  }

  // SPAs answer "quiet" with only a shell (Kalshi's nav + footer read ~400 chars in one transcript),
  // then render content a second or two later. A near-empty page is polled until its text stops
  // growing (1.2 s), at most 5 s; a page that already has content costs nothing.
  async rendered(shortChars = 600, stableMs = 1200, maxMs = 5000) {
    const len = () => this.evaluate("document.body?.innerText.length ?? 0").catch((e) => { if (e instanceof OriginBlocked) throw e; return 0; });
    let n = await len();
    if (n >= shortChars) return;
    for (let t0 = Date.now(), since = Date.now(); Date.now() - t0 < maxMs && Date.now() - since < stableMs; ) {
      await sleep(300);
      const m = await len();
      if (m > n) { n = m; since = Date.now(); if (n >= shortChars) return; }
    }
  }

  async dismissBanners() { try { return (await this.evaluate(DISMISS)) || 0; } catch (e) { if (e instanceof OriginBlocked) throw e; return 0; } }

  async observe() {
    let page;
    for (let i = 0; i < 3 && !page; i++) { try { page = await this.evaluate(SNAPSHOT); } catch (e) { if (e instanceof OriginBlocked) throw e; await sleep(300); } }
    page ??= await this.evaluate(SNAPSHOT);
    this.snap = page.snap;
    this.elements = page.elements; // what the caller was shown: `act` resolves indices against it
    this.lines = page.lines; this.scrollPos = page.scroll; this.url = page.url; // `act` reports what changed
    this.targets = page.elements.map((e) => ({ session: null, local: e.i }));
    // Cross-origin frames run in their own renderer (site isolation): snapshot each through its CDP
    // session and append its elements and text, with visibility judged in the top viewport.
    for (const session of this.frames.keys()) {
      if (page.elements.length >= 800) break;
      let o, sub;
      try { o = await this.frameOrigin(session); if (o.width < 20 || o.height < 20) continue; sub = await this.evaluate(SNAPSHOT, session); } catch { continue; }
      if (!originOk(sub.url)) continue;
      for (const e of sub.elements.slice(0, 800 - page.elements.length)) {
        this.targets.push({ session, local: e.i });
        e.i = this.targets.length;
        e.frame = sub.url;
        if (o.y + o.height < 0 || o.y > o.vh || o.x + o.width < 0 || o.x > o.vw) e.offscreen = true;
        page.elements.push(e);
      }
      page.lines.push(...sub.lines.slice(0, Math.max(0, 1500 - page.lines.length)));
    }
    return page;
  }

  // Element index -> the CDP session (null: the page itself) and the index inside that document.
  target(i) {
    const t = this.targets?.[i - 1];
    if (!t) throw new StalePage(`element ${i} is not on the current page; re-observe`);
    if (t.session && !this.frames.has(t.session)) throw new StalePage(`the frame holding element ${i} is gone; re-observe`);
    return t;
  }

  // Top-viewport position of a cross-origin frame's content box. Its <iframe> owner lives in the parent
  // document (the page, or another cross-origin frame, whose own position is then added). `owner` is
  // the outermost <iframe> in the page: the node a top-level hit test must land on.
  async frameOrigin(session) {
    const f = this.frames.get(session);
    if (!f) throw new StalePage("frame is gone");
    const { backendNodeId } = await this.cdp.send("DOM.getFrameOwner", { frameId: f.targetId }, 15000, f.parent);
    const { model } = await this.cdp.send("DOM.getBoxModel", { backendNodeId }, 15000, f.parent);
    let x = model.content[0], y = model.content[1], owner = backendNodeId;
    if (f.parent) { const up = await this.frameOrigin(f.parent); x += up.x; y += up.y; owner = up.owner; }
    const [vw, vh] = await this.evaluate("[innerWidth, innerHeight]");
    return { x, y, width: model.width, height: model.height, vw, vh, owner };
  }

  // Scroll the element into view and return its centre, refusing when another element covers it.
  async locate(i) {
    const { session, local } = this.target(i);
    const r = await this.evaluate(`(() => { const el = window.__jev?.[${local - 1}]; if (!el || !el.isConnected) return null;
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      // An empty EditContext has no width; click its rendered parent surface instead.
      const surface = el.editContext && el.parentElement && el.getBoundingClientRect().width < 2 ? el.parentElement : el;
      const b = surface.getBoundingClientRect();
      const x = b.left + b.width / 2, y = b.top + b.height / 2;
      // Hit-test in the element's own tree (shadow root or frame document), in its own coordinates.
      const top = el.getRootNode().elementFromPoint(x, y);
      // Then into top-viewport coordinates through same-origin frame owners.
      let X = x, Y = y, w = el.ownerDocument.defaultView;
      while (w.frameElement) { const f = w.frameElement.getBoundingClientRect(); X += f.left + w.frameElement.clientLeft; Y += f.top + w.frameElement.clientTop; w = w.parent; }
      let covered = !!top && top !== surface && !surface.contains(top) && !top.contains(surface);
      // The element's outermost stand-in in this document (shadow host or iframe) must also win the
      // hit test here, or a top-level modal or banner over it would take the click.
      let outer = el;
      for (let root = outer.getRootNode(); root !== document; root = outer.getRootNode()) {
        outer = root.host || root.defaultView?.frameElement; if (!outer) break;
      }
      if (outer && outer !== el) { const hit = document.elementFromPoint(X, Y); covered ||= !hit || !(hit === outer || outer.contains(hit)); }
      return { x: X, y: Y, covered, editContext: !!el.editContext }; })()`, session).catch(() => null);
    if (!r) throw new StalePage(`element ${i} is gone; re-observe`);
    if (session) {
      // Same check one level up for a cross-origin frame: the page must hit the frame's <iframe>.
      let o, hit;
      try { o = await this.frameOrigin(session); hit = await this.cdp.send("DOM.getNodeForLocation", { x: Math.round(r.x + o.x), y: Math.round(r.y + o.y) }); }
      catch { throw new StalePage(`the frame holding element ${i} moved or closed; re-observe`); }
      r.x += o.x; r.y += o.y;
      r.covered ||= hit.backendNodeId !== o.owner;
    }
    return r;
  }

  async click(i) {
    const { x, y, covered, editContext } = await this.locate(i);
    if (covered) {
      const { session, local } = this.target(i);
      const ok = await this.evaluate(`!!window.__jev?.[${local - 1}]?.click?.() || !!window.__jev?.[${local - 1}]`, session).catch(() => false);
      if (!ok) throw new StalePage(`element ${i} is gone; re-observe`);
      return;
    }
    await this.assertAllowed();
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await this.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    // Background relay tabs can receive the surface click without focusing its EditContext.
    if (editContext) {
      const { session, local } = this.target(i);
      await this.evaluate(`window.__jev?.[${local - 1}]?.focus()`, session);
    }
  }

  async type(i, text, submit = false) {
    const { session, local } = this.target(i);
    // A field in a cross-origin frame gets focus by a real click: el.focus() alone leaves the
    // keyboard on the top frame, and insertText goes wherever the keyboard is.
    if (session) {
      await this.click(i);
      // A covered frame field falls back to el.click(), which does not move the keyboard into the
      // frame: typing now would land in the top page (a stored password in the wrong field).
      const focused = await this.evaluate(`document.hasFocus() && document.activeElement === window.__jev?.[${local - 1}]`, session).catch(() => false);
      if (!focused) throw new StalePage(`could not focus element ${i} inside its frame; re-observe`);
    } else await this.locate(i);
    // Clear via the native value setter so framework-controlled inputs (React) see the change; the
    // prototype comes from the element's own window, which differs inside a frame.
    // A focus trap or script can move focus elsewhere; insertText would then type there (a stored
    // password into a visible field), so the field must hold focus in its own tree before any text.
    const focused = await this.evaluate(`(() => { const el = window.__jev[${local - 1}]; el.focus(); const w = el.ownerDocument.defaultView;
      if (el.getRootNode().activeElement !== el) return false;
      if (el.isContentEditable) { el.ownerDocument.getSelection().selectAllChildren(el); el.ownerDocument.execCommand('delete'); return el.getRootNode().activeElement === el; }
      const proto = el.tagName === 'TEXTAREA' ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true })); return el.getRootNode().activeElement === el; })()`, session);
    if (!focused) throw new StalePage(`element ${i} did not keep focus (another element took it); nothing was typed`);
    await this.insert(text);
    await this.evaluate(`window.__jev[${local - 1}]?.dispatchEvent(new Event('change', { bubbles: true }))`, session);
    if (submit) await this.key("Enter");
  }

  // Local files into an <input type=file>, the way a file chooser would set them (DOM.setFileInputFiles
  // fires input/change itself). Paths must be absolute and exist on this machine.
  async upload(i, paths) {
    const { session, local } = this.target(i);
    await this.assertAllowed(session);
    const { result, exceptionDetails } = await this.cdp.send("Runtime.evaluate", { expression: guardedExpression(`window.__jev?.[${local - 1}]`) }, 15000, session);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description?.split("\n")[0] || "page script error");
    if (!result?.objectId) throw new StalePage(`element ${i} is gone; re-observe`);
    await this.cdp.send("DOM.setFileInputFiles", { files: paths, objectId: result.objectId }, 30000, session);
  }

  // Typed text at whatever has focus: code editors (Monaco, CodeMirror) and canvases keep their own
  // model, so the value setter `type` uses never reaches them, but key input does.
  // The editor's own processing grows with the text: 25k characters took Monaco 7.6 s over direct CDP and
  // over 15 s through the relay's background tab, so the deadline grows too (the relay caps it at 120 s).
  async insert(text) { await this.assertAllowed(); await this.cdp.send("Input.insertText", { text }, 15000 + 2 * text.length); }

  async select(i, optionText) {
    const { session, local } = this.target(i);
    const ok = await this.evaluate(`(() => { const el = window.__jev?.[${local - 1}]; if (!el) return false;
      const o = [...el.options].find((o) => o.text.replace(/\\s+/g, ' ').trim() === ${JSON.stringify(optionText)}); if (!o) return false;
      el.value = o.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`, session).catch(() => false);
    if (!ok) throw new StalePage(`option "${optionText}" not found in element ${i}`);
  }

  // "Enter", "Escape", "ArrowDown", "Control+a", "Shift+Tab", single characters.
  async key(combo) {
    await this.assertAllowed();
    const parts = combo.split("+"), key = parts.pop();
    const codes = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
    const mods = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 };
    let modifiers = 0;
    for (const m of parts) { if (!mods[m]) throw new Error(`unknown modifier ${m} in "${combo}"`); modifiers |= mods[m]; }
    const single = key.length === 1;
    if (!single && !codes[key]) throw new Error(`unknown key "${key}"`);
    const vk = single ? key.toUpperCase().charCodeAt(0) : codes[key];
    const code = single ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : /\d/.test(key) ? `Digit${key}` : key) : key;
    // A plain or shifted character carries text so it is typed; with Ctrl/Alt/Meta it is a shortcut.
    const text = key === "Enter" ? "\r" : single && !(modifiers & 7) ? key : undefined;
    const base = { key: key === "Space" ? " " : key, code, windowsVirtualKeyCode: vk, modifiers };
    await this.cdp.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text } : {}) });
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  // Forget one site: its cookies (including ones set on a parent domain, which
  // Storage.clearDataForOrigin leaves behind) and its storage. Other sites keep their sessions.
  async resetOrigin(url) {
    let u; try { u = new URL(url); } catch { throw new Error(`cannot reset "${url}": not a URL`); }
    if (!/^https?:$/.test(u.protocol)) throw new Error(`cannot reset ${url}: not an http(s) origin`);
    if (!originOk(url)) throw new OriginBlocked(`${url} is outside JEV_ALLOWED_ORIGINS`);
    const origin = u.origin;
    // URL-scoped getCookies omits parent-domain cookies whose paths exclude '/'.
    const all = (await this.cdp.send("Storage.getCookies")).cookies;
    const cookies = all.filter((c) => c.domain === u.hostname || (c.domain.startsWith('.') && (u.hostname === c.domain.slice(1) || u.hostname.endsWith(c.domain))));
    for (const c of cookies) await this.cdp.send("Network.deleteCookies", { name: c.name, domain: c.domain, path: c.path, ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}) });
    await this.cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
    return { origin, cookies_deleted: cookies.length };
  }

  async screenshot(path) {
    await writeFile(path, await this.capture());
    return path;
  }

  // Capture is the one CDP call that fails transiently: a tab the extension opened in the background
  // (active:false) can be between frames. Retry before reporting, and keep every attempt's cause.
  async capture() {
    const why = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.assertAllowed();
      try {
        const { data } = await this.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 50 });
        return Buffer.from(data, "base64");
      } catch (e) {
        why.push(e.message);
        if (attempt < 2) await sleep(250 * (attempt + 1));
      }
    }
    throw new Error(`captureScreenshot failed ${why.length}x: ${[...new Set(why)].join("; ")}`);
  }

  // The window, or when the window cannot move that way, the largest visible scrollable container:
  // chat panels, feeds and app sidebars scroll inside a div, so window.scrollBy did nothing there.
  async scroll(dir) {
    await this.evaluate(`(() => { const s = ${dir === "up" ? -1 : 1}, root = document.scrollingElement || document.documentElement;
      const can = (el) => s > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 2 : el.scrollTop > 0;
      if (can(root)) return window.scrollBy(0, s * innerHeight * 0.8);
      let best = null, area = 0;
      for (const el of document.querySelectorAll('*')) {
        if (el.scrollHeight <= el.clientHeight + 2 || !can(el) || !/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)) continue;
        const b = el.getBoundingClientRect(), a = Math.max(0, Math.min(b.right, innerWidth) - Math.max(b.left, 0)) * Math.max(0, Math.min(b.bottom, innerHeight) - Math.max(b.top, 0));
        if (a > area) { area = a; best = el; }
      }
      best?.scrollBy(0, s * best.clientHeight * 0.8); })()`);
  }
  async back() { await this.evaluate("history.back()"); }

  async pageTargets() {
    if (BRIDGE) return new Set((await this.cdp.link.command("list_tabs")).map((t) => t.id));
    return new Set((await pageIds()).map((t) => t.id));
  }

  // Follow a tab *this* page opened (target=_blank): adopt it and close ours. Other harness
  // processes share the Chrome, so a new tab without our opener id is not ours.
  async adoptPopup(before) {
    let fresh;
    if (BRIDGE) {
      // The extension reports this page's popups; one sent before the list_tabs answer is here by now.
      // openerTabId is only a fallback: for a background tab Chrome sets it to the active tab.
      // The user's own tabs never match either way.
      const tabs = await this.cdp.link.command("list_tabs");
      const t = tabs.find((t) => this.cdp.popups.includes(t.id) && !before.has(t.id))
        ?? tabs.find((t) => t.openerTabId === this.tabId && !before.has(t.id));
      if (t) fresh = bridgeTarget(await this.cdp.link.command("cdp_attach", { tabId: t.id, own: true }));
    } else {
      const mine = new Set((await openedBy(this.targetId)).filter((id) => !before.has(id)));
      fresh = (await pageIds()).find((t) => mine.has(t.id));
    }
    if (!fresh) return null;
    const next = await Tab.attach(fresh);
    next.created = true; // this run's page opened it: a batch closes it as it would a tab it opened
    await next.settle();
    await this.close();
    return next;
  }

  // The user's own tabs are never closed, only detached.
  async close() {
    if (BRIDGE && !this.owned) return this.detach();
    this.cdp.close();
    if (BRIDGE) { const link = this.cdp.link; await link.command("cdp_close", { tabId: this.tabId }).catch(() => {}); releaseBridge(link); return; }
    try { await fetch(`${HTTP}/json/close/${this.targetId}`); } catch {}
  }

  // Bridge: let go of the tab but leave it open, which also lifts Chrome's debugging banner; reattach()
  // continues in it. A dedicated Chrome has no banner and nobody else's tabs: there it closes.
  async detach() {
    if (!BRIDGE) return this.close();
    const link = this.cdp.link, wasOpen = this.cdp.open;
    if (wasOpen) await this.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
    this.cdp.close();
    if (wasOpen) await link.command("cdp_detach", { tabId: this.tabId }).catch(() => {});
    releaseBridge(link);
  }

  // A fresh attach to the same tab. Element indices from the last observe stay valid: the page keeps
  // window.__jev, and indices inside cross-origin frames go stale with their old sessions.
  async reattach() {
    const t = await Tab.attach(bridgeTarget(await (await bridge()).command("cdp_attach", { tabId: this.tabId }, 20000)));
    if (this.snap && await t.evaluate("window.__jevSnap").catch(() => null) === this.snap) { t.targets = this.targets; t.snap = this.snap; t.elements = this.elements; }
    t.lines = this.lines; t.url = this.url;
    return t;
  }
}
