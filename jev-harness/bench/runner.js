// Shared task runner for the bench scripts: open a tab, browse, score while it is open, close it.
import { Tab } from "../src/browser.js";
import { browse } from "../src/engine.js";

const DONE = new Set(["done", "goal_achieved"]);

/** Default success test: a verified stop whose evidence contains `expect`, optionally on `expectUrl`. */
export const ok = (t, r) => DONE.has(r.status) && (!t.expect || JSON.stringify(r.evidence).includes(t.expect)) && (!t.expectUrl || (r.url || "").includes(t.expectUrl));

/** Run one task in a fresh tab. `score(t, r, tab)` may inspect the live page; defaults to `ok`. */
export async function runTask(t, { maxSteps = 12, score = ok } = {}) {
  const session = { tab: await Tab.open() };
  let r;
  try {
    r = await browse(session, t.goal, { url: t.url, maxSteps });
  } catch (e) {
    r = { status: "crash", notes: [e.message], jev: { calls: 0, input_tokens: 0 }, evidence: {}, elapsed_ms: 0 };
  }
  let passed = false;
  try {
    passed = await score(t, r, session.tab);
  } catch {
    passed = false;
  } finally {
    await session.tab.close().catch(() => {});
  }
  return { r, ok: passed };
}
