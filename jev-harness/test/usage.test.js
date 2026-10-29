// Offline: fetch is stubbed. Parallel runs must each see only their own Jev usage, and JEV_TRACE
// must write one line per request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const traceFile = join(mkdtempSync(join(tmpdir(), "jev-")), "trace.jsonl");
process.env.JEV_TRACE = traceFile;
process.env.TYPESAFE_API_KEY ||= "test";
const { ask, newUsage, runUsage, usage } = await import("../src/jev.js");

// Answers every question; bills `tokens` taken from the state, after a delay that interleaves runs.
globalThis.fetch = async (_url, { body }) => {
  const { state, questions } = JSON.parse(body);
  await new Promise((r) => setTimeout(r, state.delay));
  const answers = Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, q.type === "noul" ? { noul: 0.5 }
    : { choice: Object.keys(q.criteria)[0], probabilities: Object.fromEntries(Object.keys(q.criteria).map((k, i, a) => [k, i ? 0 : 1])) }]));
  return new Response(JSON.stringify({ answers, usage: { input_tokens: state.tokens, output_tokens: 1 } }));
};

test("parallel runs count their own Jev usage; the process total counts both", async () => {
  const before = usage.input_tokens;
  const q = { n: { type: "noul", instructions: "x" }, c: { type: "choice", instructions: "x", criteria: { a: null, b: null } } };
  const one = (tokens, delays) => runUsage.run(newUsage(), async () => {
    for (const delay of delays) await ask({ tokens, delay }, q);
    return runUsage.getStore();
  });
  const [a, b] = await Promise.all([one(100, [5, 20, 5]), one(7, [10, 1])]);
  assert.deepEqual([a.calls, a.input_tokens], [3, 300]);
  assert.deepEqual([b.calls, b.input_tokens], [2, 14]);
  assert.equal(usage.input_tokens - before, 314);
  const rows = readFileSync(traceFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0].questions, { n: "noul", c: 2 });
  assert.ok(rows.every((r) => r.state_chars > 0 && r.ms >= 0 && [100, 7].includes(r.input_tokens)));
});
