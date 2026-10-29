#!/usr/bin/env node
// Entry point: `mcp` (default) runs a stdio MCP server; `browse <url> <goal>` and `read <url> [query]`
// run once from the terminal and print JSON.
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { bridged, originOk, sleep, Tab, warmBridge } from "./browser.js";
import { botWall, browse, compactElements, failureShot } from "./engine.js";
import { evidence, extract, JevUnavailable, PRICE_PER_MTOK } from "./jev.js";
import { resolve, secretsFor, STORED } from "./secrets.js";

export const session = { tab: null };
const tab = async () => {
  if (session.tab && !session.tab.cdp.open) session.tab = null; // user closed it or Chrome restarted
  return (session.tab ??= await Tab.open());
};

// In the user's Chrome each tool call attaches for its own duration (Chrome shows its debugging
// banner only while attached). A call with a url takes the tab the extension picks for that site;
// one without continues in the last call's tab.
async function attachFor(url) {
  if (url) allowed(url);
  if (!bridged) return tab();
  const last = session.tab;
  session.tab = null;
  if (url) return (session.tab = await Tab.open(url));
  if (last) { try { return (session.tab = await last.reattach()); } catch {} } // it was closed meanwhile
  // Reopen the page the last call was on: a blank tab made every following read({}) return about:blank.
  return (session.tab = await Tab.open(last?.url && originOk(last.url) ? last.url : undefined));
}

// JEV_ALLOWED_ORIGINS binds every tool, not only browse: a url outside it is never loaded, and a
// live tab that has wandered outside it is neither read nor acted on.
function allowed(url) {
  if (!originOk(url)) throw new Error(`${url} is outside JEV_ALLOWED_ORIGINS`);
}

export async function read({ url, query, extract: fields, elements, screenshot }) {
  if (url) allowed(url);
  const t = await tab();
  if (url) { await t.goto(url); await t.rendered(); }
  const page = await t.observe();
  allowed(page.url);
  const out = { url: page.url, title: page.title };
  if (botWall(page)) out.blocked = "bot check or captcha page: solve it once by hand in that Chrome window, then retry";
  let plain = !(query || fields);
  try {
    if (fields) Object.assign(out, await extract(fields, page.lines));
    if (query) out.evidence = await evidence(query, page.lines);
  } catch (e) {
    // No key / TypeSafe down: the page is still readable, so degrade to plain text instead of failing.
    if (!(e instanceof JevUnavailable)) throw e;
    out.notes = [`${e.message.slice(0, 120)}; returned plain text instead`]; plain = true;
  }
  if (plain) { const text = page.lines.join("\n"); out.text = text.slice(0, 3000); if (text.length > 3000) out.text_truncated = text.length; }
  // The element table is for a takeover with `act`; a query or extract read rarely needs it.
  if (elements ?? !(query || fields)) out.elements = compactElements(page);
  // For visual checks (photo order, layout, a chart): a JPEG path, kept with the failure shots.
  if (screenshot) {
    const why = {};
    out.screenshot = (await failureShot(t, why)) ?? "screenshot failed";
    if (why.reason) out.screenshot_error = why.reason;
  }
  return out;
}

export async function act({ action, index, text, files, ms }) {
  const t = await tab();
  const needsIndex = ["click", "type", "submit", "select", "upload"].includes(action);
  if (needsIndex && !Number.isInteger(index)) throw new Error(`${action} needs an element index`);
  if (["type", "submit", "select", "insert", "key", "wait_for"].includes(action) && typeof text !== "string") throw new Error(`${action} needs text`);
  const here = await t.evaluate("location.href");
  allowed(here);
  const before = new Set(t.lines || []);
  let popup = null;
  if (action === "click") {
    const tabs = await t.pageTargets();
    await t.click(index);
    // A target=_blank click: continue in the tab it opened, as browse does, or every later read sees the old page.
    if ((popup = await t.adoptPopup(tabs).catch(() => null))) session.tab = popup;
  }
  else if (action === "type" || action === "submit") {
    // The index means what the caller was shown, so it resolves against that snapshot, never a
    // fresh one: renumbered after a DOM change, it could put a stored password in another field.
    // Credentials of the element's own site: a cross-origin frame never gets the top page's.
    const e = t.elements?.find((x) => x.i === index);
    if (!e) throw new Error(`element ${index} is not in the last page read; call read again`);
    // Typing into a button or div threw "Illegal invocation" from the value setter.
    if (e.kind !== "fill" && e.kind !== "secret") throw new Error(`element ${index} (${e.role} "${e.label.slice(0, 40)}") is not a text field; pick a textbox from the elements list`);
    await t.type(index, resolve(text, secretsFor(e.frame ?? here)), action === "submit");
  }
  else if (action === "select") await t.select(index, text);
  else if (action === "upload") {
    const e = t.elements?.find((x) => x.i === index);
    if (e?.kind !== "file") throw new Error(`element ${index} is not a file input; read with elements=true and pick a "file" entry`);
    if (!Array.isArray(files) || !files.length || (files.length > 1 && !e.multiple)) throw new Error(e.multiple ? "upload needs files: [absolute paths]" : "upload needs files: [one absolute path] (this input takes a single file)");
    const missing = files.filter((f) => typeof f !== "string" || !isAbsolute(f) || !statSync(f, { throwIfNoEntry: false })?.isFile());
    if (missing.length) throw new Error(`not an existing absolute path to a regular file: ${missing.join(", ")}`);
    await t.upload(index, files);
  }
  // Code editors (Monaco, CodeMirror), chat boxes, canvases: click into them first, then insert text.
  else if (action === "insert") await t.insert(resolveTyped(text));
  else if (action === "key") await t.key(text);
  else if (action === "wait_for") await waitFor(t, text, ms);
  else if (action === "enter") await t.key("Enter");
  else if (action === "scroll_down" || action === "scroll_up") await t.scroll(action.slice(7));
  else if (action === "back") await t.back();
  else throw new Error(`unknown action ${action}`);
  await session.tab.settle();
  const r = await read({});
  // The page text always starts at the top, so a scroll or an in-page click looked like it did
  // nothing. Lead with what the action changed, and where the page is scrolled.
  const added = (session.tab.lines || []).filter((l) => !before.has(l));
  if (popup) r.notes = ["followed a new tab"];
  r.changes = popup || !before.size ? undefined : added.length ? added.slice(0, 40) : "no visible text change";
  r.scroll = session.tab.scrollPos;
  r.text = r.text?.slice(0, 1500);
  return r;
}

// A stored credential is never inserted blindly: there is no field to scope it to a site.
const resolveTyped = (text) => { if (Object.values(STORED).includes(text)) throw new Error("insert cannot type stored credentials; use type on the password field"); return text; };

// Wait until the page shows `text` (case-insensitive), or until it is gone with a leading "!".
// ponytail: polls innerText every 500 ms; fine for "Processing…" banners, not for sub-second races.
async function waitFor(t, text, ms = 15000) {
  const gone = text.startsWith("!"), needle = (gone ? text.slice(1) : text).toLowerCase();
  const end = Date.now() + Math.min(Math.max(ms, 500), 60000);
  for (;;) {
    const has = await t.evaluate(`document.body?.innerText.toLowerCase().includes(${JSON.stringify(needle)})`);
    if (has !== gone) return;
    if (Date.now() > end) throw new Error(`wait_for timed out after ${ms} ms: "${text}" ${gone ? "still shown" : "not shown"}`);
    await sleep(500);
  }
}

const EXTRACT = { type: "object", description: "Fields to read into `data`: {name: \"description\"} or {name: {type: string|number|integer|boolean|list, description}}; a list is every matching page line, in order. Values are copied from the page (null when absent), with a per-field `confidence`.",
  additionalProperties: { anyOf: [{ type: "string" }, { type: "object", properties: { type: { enum: ["string", "number", "integer", "boolean", "list"] }, description: { type: "string" } } }] } };

const TOOLS = [
  { name: "browse", description: "Complete a web goal end to end in a Jev-driven Chrome (one call, no page dumps). Returns status, steps and the page lines that answer the goal. Omit url to continue in the current tab. With extract, also returns `data` read from the final page.",
    inputSchema: { type: "object", properties: { goal: { type: "string" }, url: { type: "string" }, max_steps: { type: "integer" }, extract: EXTRACT }, required: ["goal"] } },
  { name: "browse_many", description: "Run several independent browse goals in parallel tabs. Returns one browse result per task, in order, each with its own Jev usage.",
    inputSchema: { type: "object", properties: { tasks: { type: "array", items: { type: "object", properties: { goal: { type: "string" }, url: { type: "string" }, max_steps: { type: "integer" }, extract: EXTRACT }, required: ["goal"] } }, concurrency: { type: "integer" } }, required: ["tasks"] } },
  { name: "read", description: "Direct page read: text (3000 chars) and numbered elements. With query, returns only the lines that answer it; with extract, returns `data` in that shape instead of text. Elements are left out with query or extract unless elements is true. screenshot: true adds a JPEG path of the visible page.",
    inputSchema: { type: "object", properties: { url: { type: "string" }, query: { type: "string" }, extract: EXTRACT, elements: { type: "boolean" }, screenshot: { type: "boolean" } } } },
  { name: "session_reset", description: "Log out of one site: delete its cookies and stored data (localStorage, IndexedDB, cache) without restarting Chrome. Omit url to reset the live tab's site.",
    inputSchema: { type: "object", properties: { url: { type: "string" } } } },
  { name: "act", description: "Manual takeover on a numbered element from read/browse. action: click|type|submit|select (index + text) | upload (index of a \"file\" element + files: absolute paths) | insert (text at the focused element: code editors, chat boxes; click it first) | key (text: Enter, Escape, Tab, ArrowDown, Control+a, Shift+Tab, ...) | wait_for (text to appear, or \"!text\" to disappear; ms, default 15000) | enter|scroll_down|scroll_up|back. text \"(stored password)\" / \"(stored username)\" types the site's configured credential. Returns `changes` (new page lines) and `scroll`.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["click", "type", "submit", "select", "upload", "insert", "key", "wait_for", "enter", "scroll_down", "scroll_up", "back"] }, index: { type: "integer" }, text: { type: "string" }, files: { type: "array", items: { type: "string" } }, ms: { type: "integer" } }, required: ["action"] } },
];

// Independent goals in parallel tabs (ultrabrowse's browse_many); each task gets its own tab.
async function browseMany({ tasks, concurrency = 4 }) {
  if (!Array.isArray(tasks) || !tasks.length) throw new Error("tasks must be a non-empty array of {goal, url}");
  const out = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    for (let i; (i = next++) < tasks.length;) {
      const s = { tab: null };
      try { s.tab = await Tab.open(tasks[i].url); out[i] = await browse(s, tasks[i].goal, { url: tasks[i].url, maxSteps: tasks[i].max_steps, fields: tasks[i].extract }); }
      catch (e) { out[i] = { status: "error", notes: [e.message] }; }
      // Tabs opened for this batch go; tabs that were already there stay for later runs.
      finally { await (s.tab?.created ? s.tab.close() : s.tab?.detach())?.catch(() => {}); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), 8, tasks.length) }, worker));
  // Each result carries its own run's usage (engine.js counts per run); the total is their sum.
  const total = (k) => out.reduce((s, r) => s + (r.jev?.[k] || 0), 0);
  return { results: out, jev: { calls: total("calls"), input_tokens: total("input_tokens"), cost_usd: +(total("input_tokens") * PRICE_PER_MTOK / 1e6).toFixed(5) } };
}

export async function sessionReset({ url }) {
  if (url) allowed(url);
  const t = await tab();
  const current = await t.evaluate("location.href").catch(() => "about:blank");
  const target = url || current;
  if (!/^https?:/.test(target)) throw new Error("session_reset needs a url, or a live tab on an http(s) page");
  allowed(target);
  const r = await t.resetOrigin(target);
  // A page already open on that site still holds its old in-memory state until reloaded.
  if (new URL(current).origin === r.origin) { await t.goto(current); r.reloaded = current; }
  return r;
}

const HANDLERS = {
  browse: (a) => browse(session, a.goal, { url: a.url, maxSteps: a.max_steps, fields: a.extract }),
  browse_many: browseMany,
  read, act, session_reset: sessionReset,
};

function serve() {
  let queue = Promise.resolve(); // one browser tab: run tool calls in order
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg;
    if (id === undefined) return; // notification
    if (method === "initialize") return send({ jsonrpc: "2.0", id, result: {
      protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} },
      serverInfo: { name: "jev-harness", version: "0.1.0" } } });
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method !== "tools/call") return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
    queue = queue.then(async () => {
      const handler = HANDLERS[params?.name];
      try {
        if (!handler) throw new Error(`unknown tool ${params?.name}`);
        const args = params.arguments || {};
        if (!(bridged && params.name === "browse_many")) await attachFor(args.url);
        const result = await handler(args);
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
      } catch (e) {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `error: ${e.message}` }], isError: true } });
      } finally {
        if (bridged) await session.tab?.detach().catch(() => {});
      }
    });
  });
  rl.on("close", async () => { await queue; await session.tab?.detach().catch(() => {}); process.exit(0); });
}

// Run as a program (the MCP server or a one-shot command); imported, as by the tests, it only exports.
const entry = [process.argv[1], `${process.argv[1]}.js`].some((p) => { try { return pathToFileURL(realpathSync(p)).href === import.meta.url; } catch { return false; } });
const [cmd = "mcp", ...rest] = process.argv.slice(2);
if (!entry) { /* imported */ }
else if (cmd === "mcp") { warmBridge(); serve(); }
else {
  const run = cmd === "browse" ? () => browse(session, rest[1], { url: rest[0] })
    : cmd === "read" ? () => read({ url: rest[0], query: rest[1] })
    : null;
  if (!run) { console.error("usage: cli.js [mcp] | browse <url> <goal> | read <url> [query]"); process.exit(2); }
  try { await attachFor(rest[0]); console.log(JSON.stringify(await run(), null, 2)); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
  finally { await session.tab?.detach().catch(() => {}); }
}
