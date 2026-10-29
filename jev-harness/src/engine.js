// The loop. Code owns budgets, stop gates and recovery; Jev only ranks the next action.
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { originOk, sleep, StalePage } from "./browser.js";
import { ask, confirms, decide, evidence, extract, JevUnavailable, newUsage, NONE, parseFields, PRICE_PER_MTOK, runUsage } from "./jev.js";
import { forget, forgetSearch, learnSearch, recall, remember, searchUrl, touch } from "./memory.js";
import { resolve, secretsFor, STORED } from "./secrets.js";

const GOAL_STOP = 0.85, STUCK_STOP = 0.85, DONE_MIN_GOAL_P = 0.5;
const P_FLOOR = 0.1;            // an action below this is noise, not a plan (AgentOccam arXiv:2410.13825)
const EVIDENCE_MIN = 0.5;       // a stop needs on-page evidence of the outcome (VLAA-GUI arXiv:2604.21375)
const EVIDENCE_MIN_AGREED = 0.3; // lower bar when Jev and code agree nothing is left to do (ordering questions score ~0.3)
const BATCH_MIN_P = 0.6;        // confidence needed to fill a field the model did not pick as the next action
const OPENS = /\b(open|go to|navigate to)\b/i;
// List goals accumulate extracted items; exhaustive and trailing lists also need evidence of the end.
// No held-out task is a list goal, so the evidence bars measured there are unaffected.
const LIST_GOAL = /\b(list|enumerate|name (all|every|each))\b|\b(top|first|last) \d+\b/i;
const listWanted = (goal) => Number(goal.match(/\b(?:top|first|last) (\d+)\b/i)?.[1]) || Infinity;
const moreItems = (page) => page.scroll?.y < page.scroll?.max - 5 || page.elements.some((e) => /\b(next|load more|show more|older|more results)\b/i.test(e.label));
const REPEATABLE = /\b(more|next|previous|prev|older|newer|load|page|increase|decrease)\b|^[+−-]$/i;
const sameControl = (x = "", y = "") => x.replace(/\d+/g, "#") === y.replace(/\d+/g, "#");
const CONFIRM_MIN = 0.5;       // the picked evidence lines must state the answer, not only mention the item
const OUTCOME_STOP = 0.8;       // 0.5 won one held-out dev site and lost one test site to a wrong early stop: no signal (bench/heldout.md)
const MAX_VETOES = 2;           // evidence checks spent on stop votes before votes are ignored and the budget decides
const IRREVERSIBLE_STOP = 0.65; // fastbrowse's threshold for handing an irreversible action back to the caller
const fingerprint = (p) => createHash("sha256").update(JSON.stringify([p.url, p.lines.filter((line) => !line.startsWith("Changes since")), p.elements, p.scroll])).digest("hex");
const outsideOrigin = (error) => /outside JEV_ALLOWED_ORIGINS/.test(error.message);

// A search this site's URL is known to encode goes straight to the results URL (Skim arXiv:2605.16565):
// no typing, and no "Enter did nothing" detour to the search button.
const typedValue = (a) => a.op === "type" && a.e?.kind !== "secret" && a.text && !Object.values(STORED).includes(a.text) ? a.text : null;

async function execute(tab, a, secrets, url) {
  await tab.assertAllowed?.();
  if (a.e?.frame) secrets = secretsFor(a.e.frame); // never the top page's credentials in a third-party frame
  const shortcut = a.submit && typedValue(a) && searchUrl(url, a.e, a.text);
  if (shortcut) { a.via = shortcut; await tab.goto(shortcut); return; }
  if (a.op === "click") await tab.click(a.e.i);
  else if (a.op === "type") await tab.type(a.e.i, resolve(a.text, secrets), a.submit);
  else if (a.op === "select") await tab.select(a.e.i, a.option);
  else if (a.op === "scroll") await tab.scroll(a.dir);
  else if (a.op === "back") await tab.back();
  else if (a.op === "wait") await sleep(1000);
}

// Filter the ranked distribution down to the first action code can actually execute.
export function pick(ranked, history) {
  const last = history.at(-1);
  // Enter did not navigate: the site wants its search button, which is almost always the next control
  // in the DOM (an icon-only button Jev has little to go on). URL, not "page changed": ads and live
  // widgets make almost every page "change".
  if (last?.id.startsWith("submit_") && !last.navigated) {
    const next = ranked.find((a) => a.op === "click" && a.e.role === "button" && a.e.i === Number(last.id.slice(7)) + 1);
    if (next) return next;
  }
  for (const a of ranked) {
    if (a.op === "done" || a.p < P_FLOOR) continue;
    if (last && !last.page_changed && last.id === a.id && a.op !== "scroll") continue; // repeat with no effect -> next best
    // An expand/collapse toggle or an "add another" button changes the page on every click, so the guard
    // above never fires: runs clicked "Used 21 tools Expand to see details" 8-12 times and "New injection
    // (n/15 max)" 14 times. Two in-place clicks of one control (digits ignored: labels carry counters) are enough.
    // ponytail: label heuristic; "Load more"/"Next"/"Page n" stay repeatable for lists and paging.
    if (a.op === "click" && !REPEATABLE.test(a.e.label) && history.filter((h) => h.rec?.op === "click" && !h.navigated && h.rec.role === a.e.role && sameControl(h.rec.label, a.e.label)).length >= 2) continue;
    if (a.op === "type") {
      if (!a.text || a.text === NONE) continue;
      if (!a.submit && a.e.value === a.text) continue; // already holds the value
    }
    if (a.op === "select" && (!a.option || a.option === a.e.value)) continue;
    return a;
  }
  return null;
}

// Compound form fill (WebChallenger arXiv:2606.10423): when the chosen action fills one field, also
// apply every other confident field/option pick from the same request, so a form costs one step.
function batch(a, d) {
  if (!(a.op === "type" && !a.submit) && a.op !== "select") return [a];
  const extra = [
    ...d.fieldPicks.filter((f) => f.e.i !== a.e.i && f.p >= BATCH_MIN_P && !f.e.value).map((f) => ({ id: `type_${f.e.i}`, op: "type", e: f.e, text: f.choice, submit: false, p: f.p })),
    ...d.optionPicks.filter((f) => f.e.i !== a.e.i && f.p >= BATCH_MIN_P).map((f) => ({ id: `select_${f.e.i}`, op: "select", e: f.e, option: f.choice, p: f.p })),
    // An empty password field on the same form is filled from the stored credential.
    ...d.secretFills.filter((e) => e.i !== a.e.i).map((e) => ({ id: `password_${e.i}`, op: "type", e, text: STORED.password, submit: false, p: 1 })),
  ];
  return [a, ...extra];
}

// A plan keeps only steps that changed the page, and a `back` removes the step it undid, so a
// remembered plan never replays a detour.
export function planOf(history) {
  // Replay cannot recover a password it never stored, and storing it would write it to disk.
  if (history.some((h) => h.rec?.text === GOAL_PASSWORD)) return [];
  const plan = [];
  for (const h of history) {
    if (!h.rec || !h.page_changed) continue;
    if (h.rec.op === "back") { plan.pop(); continue; }
    // Typing into a field that the next step types into again is overwritten: keep only the last.
    const prev = plan.at(-1);
    if (prev?.op === "type" && h.rec.op === "type" && prev.role === h.rec.role && prev.label === h.rec.label) plan.pop();
    plan.push(h.rec);
  }
  return plan;
}

// Change observation (Agent-E arXiv:2407.13032): what appeared and disappeared since the last action,
// as a first page line, so "Add to cart" turning into "Remove" is visible to the outcome and evidence checks.
const sig = (e) => `${e.role} "${e.label}"${e.value ? ` =${e.value}` : ""}${e.checked !== undefined ? ` checked=${e.checked}` : ""}`;
function annotateChanges(prev, page, action) {
  if (prev.url !== page.url) { page.lines.unshift(`Changes since the last action (${action}): navigated from ${prev.url} to ${page.url}`); return; }
  const before = new Set(prev.elements.map(sig)), after = new Set(page.elements.map(sig));
  const added = [...after].filter((x) => !before.has(x)).slice(0, 6), removed = [...before].filter((x) => !after.has(x)).slice(0, 6);
  if (added.length || removed.length) page.lines.unshift(`Changes since the last action: ${added.map((x) => `+${x}`).concat(removed.map((x) => `-${x}`)).join("; ")}`);
}

const label = (a) => (a.e ? `${a.id} ${a.e.role} "${a.e.label.slice(0, 60)}"` : a.id) + (a.via ? " (via learned search URL)" : "");
// A password taken from the goal is never echoed: steps, history and plans carry this marker instead.
const GOAL_PASSWORD = "(password from goal)";
const shown = (a) => (a.e?.kind === "secret" && a.text !== STORED.password ? GOAL_PASSWORD : a.text);
const record = (a) => ({ op: a.op, role: a.e?.role, label: a.e?.label, text: shown(a), option: a.option, submit: a.submit, dir: a.dir, submitsSearch: a.submitsSearch });

// A templated value that names several elements is ambiguous: let the Jev loop choose instead.
const only = (xs) => (xs.length === 1 ? xs[0] : undefined);

// Replay a remembered plan by role+label; stops at the first element it cannot find. Returns the
// final page with the last step's change line, so the evidence check sees what the replay did.
async function replay(session, plan, history, notes, goal, budget) {
  let page = await session.tab.observe(), jumped = false;
  for (const s of plan.steps) {
    if (s.submitsSearch && jumped) { jumped = false; continue; } // the learned search URL already submitted
    if (budget()) return { complete: false, page, status: budget() };

    if (!originOk(page.url)) { notes.push(`replay stopped: ${page.url} is outside the allowed origins`); return { complete: false, page }; }
    let a;
    if (s.op === "scroll" || s.op === "back" || s.op === "wait") a = { id: s.op, ...s };
    else {
      // Exact label first; the prefix match needs a real label, or an unlabeled icon would match anything.
      // A templated step also accepts any element of that role whose label names the bound goal value.
      const e = page.elements.find((e) => e.role === s.role && e.label === s.label)
        ?? (s.label?.length >= 8 ? page.elements.find((e) => e.role === s.role && e.label.startsWith(s.label.slice(0, 30))) : undefined)
        ?? (s.contains ? only(page.elements.filter((e) => e.role === s.role && e.label.toLowerCase().includes(s.contains.toLowerCase()))) : undefined);
      if (!e) { notes.push(`replay stopped: no ${s.role} "${(s.label || "").slice(0, 40)}" on this page`); return { complete: false, page }; }
      a = { id: `${s.op}_${e.i}`, ...s, e };
    }
    const secrets = secretsFor(page.url), decision = await decide(goal, page, history, secrets);
    const next = decision.ranked[0];
    if (next.op !== a.op || next.e?.i !== a.e?.i || !!next.submit !== !!a.submit || next.dir !== a.dir) return { complete: false, page };
    if (budget()) return { complete: false, page, status: budget() };
    if (decision.irreversible_p >= IRREVERSIBLE_STOP && (a.op === "click" || a.submit) && process.env.JEV_ALLOW_IRREVERSIBLE !== "1") {
      notes.push(`replay action ${label(a)} needs confirmation`);
      return { complete: false, page, status: "needs_confirmation" };
    }
    const before = await session.tab.pageTargets();
    await execute(session.tab, a, secrets, page.url);
    history.push({ id: a.id, action: label(a), text: shown(a), option: a.option, page_changed: true, p: 1, replayed: true, rec: s });
    jumped = !!a.via;
    const popup = await session.tab.adoptPopup(before).catch(() => null);
    if (popup) { popup.reloads = session.tab.reloads; session.tab = popup; notes.push("followed a new tab"); }
    await session.tab.settle();
    const prev = page;
    page = await session.tab.observe();
    if (fingerprint(page) !== fingerprint(prev)) annotateChanges(prev, page, label(a));
  }
  return { complete: true, page };
}

/**
 * @returns {{status:string, url:string, title:string, steps:string[], evidence:object, notes:string[], jev:object}}
 */
export function browse(session, goal, opts = {}) {
  // Jev usage is counted per run, so parallel runs report their own tokens.
  return runUsage.run(newUsage(), () => run(session, goal, opts));
}

async function run(session, goal, { url, maxSteps = 25, timeoutMs = 150000, fields } = {}) {
  if (fields) parseFields(fields); // reject a bad shape before any browsing
  if (!Number.isInteger(maxSteps) || maxSteps < 0) throw new Error("maxSteps must be a non-negative integer");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("timeoutMs must be a non-negative number");
  const started = Date.now(), notes = [], history = [];
  const budget = () => Date.now() - started >= timeoutMs ? "timeout" : history.length >= maxSteps ? "max_steps" : null;
  const listGoal = LIST_GOAL.test(goal), wanted = listWanted(goal), lastItems = /\blast \d+\b/i.test(goal);
  let page, status = null, finalEvidence = null, vetoes = 0, startUrl = url, items = [];
  const collected = new Set();
  if (url && !originOk(url)) status = "blocked_origin";
  else {
    try {
      if (url) { await session.tab.goto(url); await session.tab.rendered(); }
      await session.tab.assertAllowed?.();
      page = await session.tab.observe();
      if (!originOk(page.url)) status = "blocked_origin";
      else {
        if (await session.tab.dismissBanners()) { notes.push("dismissed a cookie/consent banner"); page = await session.tab.observe(); }
        for (const end = Math.min(Date.now() + 4000, started + timeoutMs); originOk(page.url) && !page.elements.length && Date.now() < end; ) {
          await sleep(Math.min(400, end - Date.now()));
          if (Date.now() < end) page = await session.tab.observe();
        }
        startUrl ??= page.url;
        if (!originOk(page.url)) status = "blocked_origin";
        else if (botWall(page)) { status = "blocked"; notes.push(`bot check or captcha page ("${page.title}"): solve it once by hand in that Chrome window, then retry`); }
      }
    } catch (error) {
      if (!outsideOrigin(error)) throw error;
      status = "blocked_origin"; notes.push(error.message);
    }
  }

  // Stop only with on-page evidence of the outcome. A vetoed vote is not the end: the loop goes on
  // to act, and only when nothing executable is left does the run end "unverified".
  const finish = async (why, min = EVIDENCE_MIN, inline = null) => {
    if (Date.now() - started >= timeoutMs) return "timeout";
    await session.tab.assertAllowed?.();
    if (!originOk(page.url)) return "blocked_origin";
    if (listGoal) {
      if (items.length < wanted && Number.isFinite(wanted) || (OPENS.test(goal) && !history.some((h) => h.navigated || h.replayed))) return null;
      if (!lastItems && Number.isFinite(wanted)) {
        items = items.slice(0, wanted);
      } else {
        if (moreItems(page)) return null;
        const answer = await ask({ goal, collected_items: items.length, page: { url: page.url, lines: page.lines, elements: page.elements } }, {
          exhausted: { type: "noul", instructions: "Does the page provide evidence that this is the end of the requested collection, with no remaining pages or results? Do not infer completeness merely because some matching items are shown." },
        });
        if (answer.exhausted.noul < GOAL_STOP) return null;
        if (lastItems) items = items.slice(-wanted);
      }
      finalEvidence = { exists: 1, lines: items.slice(0, 4).map((line) => ({ line, p: 1 })) };
      return Date.now() - started >= timeoutMs ? "timeout" : why;
    }
    // Evidence asked speculatively in the same decide request (same page) saves a call when it
    // already clears the bar; otherwise the full evidence request looks at more of the page.
    let ev = inline && inline.exists >= min ? inline : await evidence(goal, page.lines);
    if (process.env.JEV_DEBUG) console.error(JSON.stringify({ finish: why, exists: ev.exists, url: page.url, first_lines: page.lines.slice(0, 3).map((l) => l.slice(0, 140)) }));
    finalEvidence = ev;
    if (ev.exists >= min) {
      // On-topic is not answered: the picked lines themselves must answer the goal (held-out false
      // positives: "Capital: Pago Pago" for Belize, a title without its author).
      let c = await confirms(goal, ev, page);
      // The inline pick sees only the step's text window; the full request may find the answer line.
      if (c < CONFIRM_MIN && ev === inline) {
        const full = await evidence(goal, page.lines);
        if (full.exists >= min) { ev = finalEvidence = full; c = await confirms(goal, full, page); }
      }
      ev.confirmed = c;
      if (c >= CONFIRM_MIN) return Date.now() - started >= timeoutMs ? "timeout" : why;
      vetoes++; notes.push(`${why} vetoed: the evidence lines do not answer the goal (confirmed=${c})`);
      return null;
    }
    vetoes++; notes.push(`${why} vetoed: no on-page evidence yet (exists=${ev.exists})`);
    return null;
  };

  // Warm path: a remembered plan for this exact goal on this site.
  const plan = !status && !listGoal && startUrl ? recall(startUrl, goal) : null;
  if (plan) {
    try {
      const r = await replay(session, plan, history, notes, goal, budget), complete = r.complete;
      page = r.page;
      status = r.status;
      // The plan was verified when it was learned, so the agreed (lower) evidence bar applies.
      if (complete && (status = await finish("done", EVIDENCE_MIN_AGREED)) === "done")
        notes.push(`replayed a remembered ${plan.steps.length}-step plan${plan.template ? ` (template "${plan.template}" with ${plan.values.map((v) => `"${v}"`).join(", ")})` : ""}`);
      status ||= budget();
    } catch (e) {
      notes.push(`replay aborted: ${e.message.slice(0, 120)}`);
      if (outsideOrigin(e)) status = "blocked_origin";
      else page = await session.tab.observe();
    }
    // A plan that no longer works is dropped so it cannot poison later runs; its failed vote is not
    // charged to the Jev loop, and a run that heals it re-stores the full sequence.
    if (!status) { forget(plan.key); vetoes = 0; finalEvidence = null; notes.push("remembered plan did not verify; forgotten"); }
  }

  // Separate one-shot rescues: a stale element must not use up the no-progress retry, or vice versa.
  let staleRescued = false, stallRescued = false, noEffect = 0, waits = 0, jevError;
  const visits = new Map(); // state fingerprint -> times seen; A/B/A/B loops evade the repeat guard
  while (!status) {
    if (budget()) { status = budget(); break; }
    if (!originOk(page.url)) { status = "blocked_origin"; notes.push(`left the allowed origins: ${page.url}`); break; }
    if (botWall(page)) { status = "blocked"; notes.push(`bot check or captcha page ("${page.title}"): solve it once by hand in that Chrome window, then retry`); break; }
    // Any Jev/CDP failure ends the run as "error" but still returns the steps already taken.
    try {
      // Read every bounded chunk so an exhaustive request cannot silently drop lines after the first window.
      if (listGoal && (!history.length || history.at(-1).page_changed)) {
        for (let offset = 0; offset < page.lines.length; offset += 120) {
          if (Date.now() - started >= timeoutMs) { status = "timeout"; break; }
          const found = (await extract({ items: { type: "list", description: `All candidate items for ${goal}; include them in document order before applying first/last/count limits.` } }, page.lines.slice(offset, offset + 120))).data.items;
          for (const item of found) if (!collected.has(item)) { collected.add(item); items.push(item); }
        }
        if (status) break;
        if ((status = await finish("done"))) break;
      }
      const secrets = secretsFor(page.url);
      const d = await decide(goal, page, history, secrets);
      if (Date.now() - started >= timeoutMs) { status = "timeout"; break; }
      if (process.env.JEV_DEBUG) console.error(JSON.stringify({ outcome_p: d.outcome_p, stuck_p: d.stuck_p, top: d.ranked.slice(0, 6).map((a) => [a.id, +a.p.toFixed(2), a.text]), fields: d.fieldPicks.map((f) => [f.e.i, f.choice, +f.p.toFixed(2)]) }));
      const top = d.ranked[0];
      // Jev reads goals literally ("find X in the catalog" is not "shown" on X's page), so a strong
      // outcome-visible signal counts as a stop vote too. One evidence check per iteration.
      const wantStop = d.outcome_p > GOAL_STOP ? (top.op === "done" ? "done" : "goal_achieved")
        : (top.op === "done" && d.outcome_p >= DONE_MIN_GOAL_P) || d.outcome_p >= OUTCOME_STOP ? "done" : null;
      // "Open the page for the dialog element and report …" must open something: a stop before any
      // navigation (MDN's index already summarised the element) answers only half the goal.
      const unopened = wantStop && OPENS.test(goal) && !history.some((h) => h.navigated || h.replayed);
      if (unopened && vetoes < MAX_VETOES) { vetoes++; notes.push(`${wantStop} vetoed: the goal asks to open a page and none was opened yet`); }
      else if (wantStop && vetoes < MAX_VETOES && (status = await finish(wantStop, EVIDENCE_MIN, d.evidence))) break; // vetoed: act instead
      if (d.stuck_p > STUCK_STOP) { status = "stuck"; notes.push(`stuck probability ${d.stuck_p.toFixed(2)}`); break; }
      const a = pick(d.ranked, history);
      if (!a) {
        // Nothing left to do is often what "done" looks like (the requested control already holds
        // its value): let the evidence check decide before calling it stuck.
        if (vetoes <= MAX_VETOES && (status = await finish("done", EVIDENCE_MIN_AGREED, d.evidence))) break;
        status = listGoal || vetoes ? "unverified" : "stuck";
        notes.push(page.elements.some((e) => e.kind === "secret") && !secrets?.password
          ? "a password field needs credentials: set JEV_SECRETS or ~/.jev-harness/secrets.json for this site"
          : "no executable action above the probability floor (a field may need text the goal does not state)"); break;
      }
      if (d.irreversible_p >= IRREVERSIBLE_STOP && (a.op === "click" || a.submit) && process.env.JEV_ALLOW_IRREVERSIBLE !== "1") {
        status = "needs_confirmation"; notes.push(`next action ${label(a)} looks irreversible (p=${d.irreversible_p.toFixed(2)}); set JEV_ALLOW_IRREVERSIBLE=1 or use act`); break;
      }

      const before = await session.tab.pageTargets();
      const actions = batch(a, d).slice(0, maxSteps - history.length), executed = [];
      try { for (const x of actions) { if (Date.now() - started >= timeoutMs) { status = "timeout"; break; } await execute(session.tab, x, secrets, page.url); executed.push(x); } }
      catch (e) {
        if (!(e instanceof StalePage) || staleRescued) throw e;
        // Fields typed before the stale element still count, so the plan remembers them.
        for (const x of executed) history.push({ id: x.id, action: label(x), text: shown(x), option: x.option, page_changed: true, p: +x.p.toFixed(2), rec: record(x), o: +d.outcome_p.toFixed(2) });
        staleRescued = true; notes.push(`${e.message}; re-observed`); page = await session.tab.observe(); continue;
      }
      const popup = await session.tab.adoptPopup(before).catch(() => null);
      if (popup) { popup.reloads = session.tab.reloads; session.tab = popup; notes.push("followed a new tab"); }
      await session.tab.settle();
      const prev = page;
      page = await session.tab.observe();
      const changed = fingerprint(page) !== fingerprint(prev);
      if (changed) annotateChanges(prev, page, label(a));
      // Learn the site's search URL from a search that navigated: typed and submitted in this step, or
      // typed in the previous step and submitted by clicking the search button now.
      if (page.url !== prev.url && !a.via) {
        const last = history.at(-1);
        // A category link that happens to share the typed word is not a search: the click must be a button.
        const typed = typedValue(a) && a.submit ? a : (a.op === "click" && a.e.role === "button" && !last?.navigated && last?.typed) || null;
        // The search button click is what a learned search URL replaces on replay.
        if (typed && learnSearch(prev.url, page.url, typed.e, typed.text) && typed !== a) a.submitsSearch = true;
      }
      for (const x of executed) history.push({ id: x.id, via: x.via && { url: prev.url, e: x.e }, action: label(x), text: shown(x), option: x.option, page_changed: changed, navigated: page.url !== prev.url, p: +x.p.toFixed(2), rec: record(x),
        typed: typedValue(x) ? { e: x.e, text: x.text } : undefined,
        o: +d.outcome_p.toFixed(2) });
      if (actions.length > 1) notes.push(`filled ${actions.length} fields in one step`);

      waits = a.op === "wait" ? waits + 1 : 0;
      noEffect = changed || a.op === "wait" ? 0 : noEffect + 1;
      const fp = fingerprint(page), seen = (visits.get(fp) || 0) + 1;
      visits.set(fp, seen);
      if (seen >= 3) {
        if ((status = await finish("done"))) break; // a revisited page may simply be the finished one
        status = "stuck"; notes.push("looping between the same pages"); break;
      }
      if (noEffect >= 3 || waits >= 3) {
        if (stallRescued) { status = "stuck"; notes.push("three steps without progress"); break; }
        stallRescued = true; noEffect = waits = 0;
        await session.tab.dismissBanners(); await session.tab.key("Escape").catch(() => {});
        notes.push("no progress for three steps; cleared overlays and retried");
        page = await session.tab.observe();
      }
    } catch (e) {
      status = outsideOrigin(e) ? "blocked_origin" : "error"; notes.push(e.message.slice(0, 200));
      if (e instanceof JevUnavailable) jevError = e.message.slice(0, 200); // TypeSafe itself is down: another agent may take over
    }
  }

  if (!page) page = { url: startUrl, title: "", lines: [], elements: [] };
  else if (!["blocked_origin", "timeout"].includes(status)) {
    try { await session.tab.assertAllowed?.(); page = await session.tab.observe(); if (!originOk(page.url)) status = "blocked_origin"; }
    catch (error) { if (outsideOrigin(error)) status = "blocked_origin"; }
  }
  if (status === "blocked_origin") page = { url: page.url, title: "", lines: [], elements: [] };
  const ev = ["timeout", "blocked_origin"].includes(status) ? { exists: 0, lines: [], error: status === "timeout" ? "run deadline exceeded" : "outside JEV_ALLOWED_ORIGINS" }
    : (finalEvidence && ["done", "goal_achieved", "unverified"].includes(status)) ? finalEvidence : await evidence(goal, page.lines).catch((e) => ({ error: e.message }));
  const verified = ["done", "goal_achieved"].includes(status);
  if (verified && plan) touch(plan.key); // a pure replay rewrites nothing, so eviction would drop it first
  if (verified && startUrl && history.some((h) => !h.replayed)) remember(startUrl, goal, planOf(history));
  // A learned search URL that led nowhere verifiable may be wrong: forget it rather than repeat it.
  if (!verified) for (const h of history) if (h.via) forgetSearch(h.via);
  // Structured fields read from the final page, whatever the status: a partial page may still hold them.
  let data;
  if (fields && !["timeout", "blocked_origin"].includes(status)) { try { data = await extract(fields, page.lines); } catch (e) { notes.push(`extract failed: ${e.message.slice(0, 120)}`); } }
  const u = runUsage.getStore();
  const result = {
    status, url: page.url, title: page.title,
    steps: history.map((h) => `${h.action}${h.text ? ` <- "${h.text}"` : ""}${h.option ? ` <- "${h.option}"` : ""}${h.replayed ? " (replayed)" : ` p=${h.p} outcome=${h.o}`}${h.page_changed ? "" : " (no change)"}`),
    evidence: ev,
    jev: { calls: u.calls, input_tokens: u.input_tokens, cost_usd: +(u.input_tokens * PRICE_PER_MTOK / 1e6).toFixed(5), ms: u.ms, elements_max: u.elements_max, ...(u.model ? { model: u.model } : {}), ...(jevError ? { error: jevError } : {}) },
    elapsed_ms: Date.now() - started,
  };
  if (data) Object.assign(result, data);
  if (listGoal) result.items = items;
  if (session.tab.reloads?.length) notes.push(...session.tab.reloads.splice(0));
  if (notes.length) result.notes = notes;
  if (session.tab.dialogs.length) { const dialogs = session.tab.dialogs.splice(0); if (status !== "blocked_origin") result.dialogs = dialogs; }
  // Only a failed run needs the element table and a screenshot, so the caller can take over with `act`.
  if (!verified) {
    result.elements = compactElements(page, 40);
    const shot = ["timeout", "blocked_origin"].includes(status) ? null : await failureShot(session.tab);
    if (shot) result.screenshot = shot;
  }
  return result;
}

const KEEP_SHOTS = 50;
/** A failed run's screenshot under ~/.jev-harness/shots, keeping only the newest KEEP_SHOTS: in the
 * user's own Chrome they show signed-in pages. Null when the capture fails, with the cause in `why.reason`. */
export async function failureShot(tab, why = null) {
  try {
    const dir = join(process.env.JEV_HOME || join(homedir(), ".jev-harness"), "shots");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = await tab.screenshot(join(dir, `${Date.now()}.jpg`));
    for (const old of readdirSync(dir).filter((f) => /^\d+\.jpg$/.test(f)).sort((a, b) => parseInt(b) - parseInt(a)).slice(KEEP_SHOTS)) {
      try { unlinkSync(join(dir, old)); } catch {}
    }
    return path;
  } catch (e) {
    // Swallowing this made read({screenshot}) answer a bare "screenshot failed" with no cause.
    if (why) why.reason = e?.message || String(e);
    return null;
  }
}

// Cloudflare / captcha interstitials: no goal is reachable from one, and a retry gets the same page.
const WALL_TITLE = /^(just a moment|attention required|verify you are human|access denied|are you a robot)/i;
const WALL_TEXT = /\b(verify(ing)? you are (a )?human|checking (if the site connection is secure|your browser)|complete the (security check|captcha)|press (&|and) hold|enter the characters (seen|shown) in the image)\b/i;
export const botWall = (page) => WALL_TITLE.test(page.title || "") || (page.lines.length < 40 && page.lines.some((l) => WALL_TEXT.test(l)));

export function compactElements(page, max = 60) {
  return page.elements.filter((e) => !e.offscreen).slice(0, max).map((e) =>
    `[${e.i}] ${e.role} "${e.label.slice(0, 60)}"${e.value ? ` =${JSON.stringify(e.value)}` : ""}${e.checked !== undefined ? ` checked=${e.checked}` : ""}`).join("\n");
}
