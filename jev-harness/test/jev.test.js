import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiKey, spans, validateChoice } from "../src/jev.js";

test("apiKey prefers the environment, then falls back to JEV_ENV_FILE", (t) => {
  const saved = { key: process.env.TYPESAFE_API_KEY, file: process.env.JEV_ENV_FILE };
  t.after(() => {
    for (const [k, v] of [["TYPESAFE_API_KEY", saved.key], ["JEV_ENV_FILE", saved.file]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });
  const file = join(mkdtempSync(join(tmpdir(), "jev-env-")), ".env");
  writeFileSync(file, '# comment\nOTHER=x\nTYPESAFE_API_KEY="from-file"\n');
  process.env.JEV_ENV_FILE = file;
  process.env.TYPESAFE_API_KEY = "from-env";
  assert.equal(apiKey(), "from-env");
  delete process.env.TYPESAFE_API_KEY;
  assert.equal(apiKey(), "from-file");
  process.env.JEV_ENV_FILE = join(file, "..", "missing.env");
  assert.equal(apiKey(), undefined);
});

test("spans keep typed values verbatim and drop stopword-bounded runs", () => {
  const s = spans('Search the store for wireless mouse, then email "Ada Lovelace" at ada@example.com about order 1234.');
  for (const want of ["wireless mouse", "Ada Lovelace", "ada@example.com", "1234"]) assert.ok(s.includes(want), want);
  assert.ok(!s.includes("the store"), "stopword-led run excluded");
  assert.ok(!s.includes("for wireless mouse"), "stopword-led run excluded");
  assert.ok(s.length <= 249);
});

test("spans ignore apostrophes inside words", () => {
  assert.ok(!spans("don't open Bob's page").some((x) => x.startsWith("t open")));
});

test("validateChoice rejects unknown options and bad distributions", () => {
  const ok = { choice: "a", probabilities: { a: 0.7, b: 0.3 }, confidence: 0.5 };
  assert.equal(validateChoice(ok, ["a", "b"]), ok);
  assert.throws(() => validateChoice({ ...ok, choice: "c" }, ["a", "b"]));
  assert.throws(() => validateChoice({ ...ok, probabilities: { a: 0.7, b: 0.7 } }, ["a", "b"]));
  assert.throws(() => validateChoice({ ...ok, probabilities: { a: 1 } }, ["a", "b"]));
});

test("spans keep tokens whose punctuation is part of the value", () => {
  const s = spans("Log in with password SuperSecretPassword! and open the Anker 7-in-1 hub.");
  assert.ok(s.includes("SuperSecretPassword!"));
  assert.ok(s.includes("7-in-1"));
});

test("relevance weights rare words, so one record beats a column of shared labels", async () => {
  const { relevance, withNeighbours } = await import("../src/jev.js");
  const lines = [];
  for (const [c, cap] of [["Andorra", "Andorra la Vella"], ["Austria", "Vienna"], ["Belize", "Belmopan"], ["Canada", "Ottawa"]]) lines.push(c, `Capital: ${cap}`, "Population: 1");
  const r = relevance(lines, "Report the capital of Belize.");
  assert.equal(r.indexOf(Math.max(...r)), 6, "the Belize line ranks first");
  assert.deepEqual(withNeighbours([6], lines.length).slice(0, 2), [6, 7], "and brings its Capital line");
});

test("only goals that ask for information get the answer check", async () => {
  const { asksForInfo } = await import("../src/jev.js");
  assert.deepEqual(["Report the capital of Belize.", "Who designed Python?", "Sign in with my stored credentials.", "Select Option 2 in the dropdown list."].map(asksForInfo), [true, true, false, false]);
});

test("askedAttribute names the field a goal asks to report", async () => {
  const { askedAttribute } = await import("../src/jev.js");
  assert.equal(askedAttribute("Search for github.com/gorilla/mux, open the package and report its license."), "license");
  assert.equal(askedAttribute("Report the release date of this eBook."), "release date");
  assert.equal(askedAttribute("Report the TLD manager of the .museum domain."), "tld manager");
  assert.equal(askedAttribute("Report how much Frank Bach owes."), null);
  assert.equal(askedAttribute("Sign in with my stored credentials."), null);
});

test("a unique labelled field beats prose; a label repeated with different values does not", async () => {
  const { preferField } = await import("../src/jev.js");
  const prose = { exists: 0.9, lines: [{ line: "BSD licensed. See the LICENSE file for details.", p: 1 }] };
  const q = "Open the package and report its license.";
  assert.equal(preferField(q, ["mux", "License: BSD-3-Clause", "Readme", "BSD licensed. See the LICENSE file for details."], prose).lines[0].line, "License: BSD-3-Clause");
  assert.equal(preferField(q, ["mux", "License", "MIT", "MIT licensed, see LICENSE."], prose).lines[0].line, "License: MIT", "label and value on two lines");
  const countries = ["Andorra", "Capital: Andorra la Vella", "Belize", "Capital: Belmopan"];
  const ev = { exists: 0.9, lines: [{ line: "Capital: Belmopan", p: 0.9 }] };
  assert.equal(preferField("Report the capital of Belize.", countries, ev), ev, "many records: left to Jev");
});
