// Plan cache (Agentic Plan Caching, arXiv:2506.14852; Agent Workflow Memory, arXiv:2409.07429): a run
// that ended with verified evidence stores its action sequence by (origin, goal). A repeat of the same
// goal on the same site replays it by element role+label, rechecking each action's safety with Jev;
// the evidence check still has to pass, and changed choices fall back to the Jev loop.
//
// Plans with blanks (Agent Skill Induction, arXiv:2504.06821; AWM's abstracted workflows): the goal
// values a plan used (typed text, a chosen option, a clicked label that names the goal's item) become
// slots, so "search for dress …" and "search for shirt …" share one plan. The goal template is the goal
// with those values cut out; a new goal that matches it literally binds the slots in code, no Jev call.
//
// Learned search URLs (Skim, arXiv:2605.16565): when a search submit lands on a URL that carries the
// query, the URL pattern is kept per site, and later searches in the same field navigate to it directly.
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { spans } from "./jev.js";

const DIR = process.env.JEV_HOME || join(homedir(), ".jev-harness");
// Old whole-file caches normalized literal values; start fresh rather than replay unsafe entries.
const CACHE = join(DIR, "plans-v2");
const MAX_PLANS = 500;
const off = () => process.env.JEV_NO_MEMORY === "1";

const host = (url) => { try { return new URL(url).host; } catch { return ""; } };
const key = (url, goal) => `${host(url)}|${goal}`;
const tplKey = (url, template) => `tpl|${host(url)}|${template}`;
const entryPath = (key) => join(CACHE, `${createHash("sha256").update(key).digest("hex")}.json`);
const files = () => { try { return readdirSync(CACHE).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)); } catch { return []; } };
const validSteps = (steps) => Array.isArray(steps) && steps.every((step) => step && ["click", "type", "select", "scroll", "back", "wait"].includes(step.op));

function load() {
  const plans = Object.create(null);
  for (const name of files()) {
    try {
      const entry = JSON.parse(readFileSync(join(CACHE, name), "utf8"));
      if (typeof entry.key === "string" && entry.value && typeof entry.value === "object") plans[entry.key] = entry.value;
    } catch {} // A corrupt or concurrently evicted entry does not disable the remaining cache.
  }
  return plans;
}

// One entry by key, without reading the rest of the cache.
function entry(key) {
  try {
    const e = JSON.parse(readFileSync(entryPath(key), "utf8"));
    return e.key === key && e.value && typeof e.value === "object" ? e.value : undefined;
  } catch { return undefined; }
}

// Independent keys never share a read/modify/write; simultaneous writes to one key are last-writer-wins.
function save(key, value) {
  const path = entryPath(key), temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(temporary, JSON.stringify({ key, value }));
    renameSync(temporary, path);
    const entries = files();
    if (entries.length > MAX_PLANS) {
      const age = (name) => { try { return statSync(join(CACHE, name)).mtimeMs; } catch { return 0; } };
      const oldest = entries.map((name) => ({ name, time: age(name) })).sort((a, b) => b.time - a.time).slice(MAX_PLANS);
      for (const { name } of oldest) {
        try { unlinkSync(join(CACHE, name)); } catch {}
      }
    }
    return true;
  } catch { return false; } // Cache failure must not turn completed browser work into a tool error.
  finally { try { unlinkSync(temporary); } catch {} }
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SLOT = /\{(\d+)\}/g;
// Labels may ignore case; locating literal goal values must preserve it.
const wordIndex = (hay, needle, flags = "iu") => { const m = new RegExp(`(^|[^\\p{L}\\p{N}])${escape(needle)}(?![\\p{L}\\p{N}])`, flags).exec(hay); return m ? m.index + m[1].length : -1; };
const cut = (s, i, len, by) => s.slice(0, i) + by + s.slice(i + len);

// Short single words ("a", "cart", "price") are too generic to pick one element by: an item name
// has 6+ characters, a space, or a digit. Applied when learning and again when binding a new goal.
const namesItem = (v) => v.length >= 6 || /\s|\d/.test(v);

/**
 * Turn a verified plan into a template: returns `{ template, steps }` with `{0}`, `{1}` … in place of
 * goal values, or null when the plan uses no goal value (nothing to generalise).
 */
export function templatize(goal, steps) {
  // Longest first, so "Logitech M185" wins over "M185".
  const cands = spans(goal).filter((c) => c.length >= 2).sort((a, b) => b.length - a.length);
  const slots = [];
  const slotOf = (v) => { let i = slots.indexOf(v); if (i < 0) i = slots.push(v) - 1; return i; };
  const exact = (v) => v && cands.find((c) => c === v);
  const out = steps.map((s) => {
    const t = { ...s };
    const tx = exact(s.text); if (tx) t.text = `{${slotOf(tx)}}`;
    const op = exact(s.option); if (op) t.option = `{${slotOf(op)}}`;
    // A clicked label that names the goal's item ("Keychron K2 Wireless Keyboard" for "the Keychron K2").
    // Short single words ("price", "cart") are too generic to be the variable part.
    // A value already typed is the search, not the item picked from its results: prefer a new one.
    if (s.op === "click" && s.label) {
      const named = cands.filter((c) => namesItem(c) && wordIndex(s.label, c) >= 0);
      const c = named.find((c) => !slots.some((v) => v.toLowerCase() === c.toLowerCase())) ?? named[0];
      if (c) { t.slot = slotOf(c); t.label = cut(s.label, wordIndex(s.label, c), c.length, `{${t.slot}}`); }
    }
    return t;
  });
  if (!slots.length) return null;
  let template = goal;
  // Each slot value must occur in the goal outside an earlier slot, or the template is ambiguous.
  for (const [i, v] of slots.map((v, i) => [i, v]).sort((a, b) => b[1].length - a[1].length)) {
    const at = wordIndex(template.replace(SLOT, (m) => "\0".repeat(m.length)), v, "u");
    if (at < 0) return null;
    template = cut(template, at, v.length, `{${i}}`);
  }
  // Enough fixed wording must remain that a match means "the same kind of task".
  if (template.replace(SLOT, "").replace(/\W/g, "").length < 10) return null;
  return { template, steps: out };
}

/** Bind a template to a new goal: slot values in order, or null when the goal does not fit. */
export function match(template, goal) {
  const parts = template.trim().replace(/[.!?]+$/, "").split(SLOT); // literal, index, literal, index, …
  // Literal wording must match (any whitespace run matches any other); each slot takes a lazy group.
  const re = parts.map((p, k) => (k % 2 ? "(.+?)" : escape(p).replace(/\s+/g, "\\s+"))).join("");
  const m = goal.trim().match(new RegExp(`^${re}[.!?]*$`, "i"));
  if (!m) return null;
  const values = [];
  parts.filter((_, k) => k % 2).forEach((slot, k) => { values[Number(slot)] = m[k + 1]; });
  return values.length && values.every((v) => v && v.length <= 100) ? values : null;
}

const fill = (s, values) => s?.replace(SLOT, (_, i) => values[i] ?? "");

export function recall(url, goal) {
  if (off()) return null;
  const k = key(url, goal), exact = entry(k);
  if (validSteps(exact?.steps)) return { key: k, steps: exact.steps };
  if (/\s{2,}|[\r\n\t]/.test(goal)) return null; // Literal whitespace cannot be rebound by flexible templates.
  const prefix = `tpl|${host(url)}|`;
  for (const [tk, p] of Object.entries(load())) {
    if (!tk.startsWith(prefix)) continue;
    if (typeof p.template !== "string" || !validSteps(p.steps)) continue;
    const values = match(p.template, goal);
    if (!values) continue;
    if (p.steps.some((s) => s.slot !== undefined && !namesItem(values[s.slot]))) continue;
    const steps = p.steps.map((s) => ({ ...s, text: fill(s.text, values), option: fill(s.option, values), label: fill(s.label, values),
      contains: s.slot !== undefined ? values[s.slot] : undefined }));
    return { key: tk, steps, template: p.template, values };
  }
  return null;
}

export function remember(url, goal, steps) {
  if (off() || !steps.length) return;
  save(key(url, goal), { saved: new Date().toISOString(), steps });
  const t = /\s{2,}|[\r\n\t]/.test(goal) ? null : templatize(goal, steps);
  if (t) save(tplKey(url, t.template), { saved: new Date().toISOString(), template: t.template, steps: t.steps });
}

// Eviction drops the oldest files first; a replay that verified marks its plan as recently used.
export function touch(k) {
  const now = new Date();
  try { utimesSync(entryPath(k), now, now); } catch {}
}

export function forget(k) {
  try { unlinkSync(entryPath(k)); } catch {}
}

// --- learned search URLs ---

const decodeQ = (v) => { try { return decodeURIComponent(v.replace(/\+/g, " ")).trim().toLowerCase(); } catch { return ""; } };

/** Where does `text` sit in `url`? `{ param }` for a query parameter, `{ segment }` for a path segment. */
export function locateQuery(url, text) {
  let u; try { u = new URL(url); } catch { return null; }
  const want = text.trim().toLowerCase();
  if (want.length < 2) return null;
  for (const [name, v] of u.searchParams) if (v.trim().toLowerCase() === want) return { param: name };
  const segs = u.pathname.split("/");
  const i = segs.findIndex((s) => s && decodeQ(s) === want);
  return i >= 0 ? { segment: i } : null;
}

// Other query parameters are kept only when they look like fixed options (searchtype=all,
// source=header): ids, emails, tokens and page numbers from the learning run must not follow
// every later search.
const optionLike = (v) => /^[a-z_-]{1,16}$/i.test(v);

/** The learned URL with `text` in the query's place. */
export function searchUrlFrom(learned, text) {
  const u = new URL(learned.url);
  for (const [k, v] of [...u.searchParams]) if (k !== learned.param && !optionLike(v)) u.searchParams.delete(k);
  if (learned.param !== undefined) u.searchParams.set(learned.param, text);
  else { const segs = u.pathname.split("/"); segs[learned.segment] = encodeURIComponent(text); u.pathname = segs.join("/"); }
  return u.href;
}

// Only a field that presents itself as a search box: a newsletter "Email" GET form must never
// become a shortcut.
const searchField = (e) => !!e && (e.search || e.role === "searchbox" || /search|query|find|keyword/i.test(e.label || ""));
const searchKey = (url, e) => `search|${host(url)}|${e.role}|${e.label}`;

/** Remember the search URL when `toUrl` carries `text` typed into search field `e`; returns whether it did. */
export function learnSearch(fromUrl, toUrl, e, text) {
  if (off() || !searchField(e) || host(fromUrl) !== host(toUrl)) return false;
  const at = locateQuery(toUrl, text);
  if (!at) return false;
  return save(searchKey(toUrl, e), { saved: new Date().toISOString(), url: searchUrlFrom({ url: toUrl, ...at }, text), ...at });
}

/** URL for searching `text` in field `e` on this site, when one was learned. */
export function searchUrl(pageUrl, e, text) {
  if (off() || !text || !searchField(e)) return null;
  const k = searchKey(pageUrl, e), learned = entry(k);
  if (learned) touch(k); // a used shortcut is never re-learned, so mark it recent for eviction

  try { return learned ? searchUrlFrom(learned, text) : null; } catch { return null; }
}

/** Drop the search URL learned for field `via.e` on `via.url`'s site. */
export function forgetSearch(via) {
  forget(searchKey(via.url, via.e));
}
