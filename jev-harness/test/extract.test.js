// Offline: parsing rules for structured extraction, and one extract() request with stubbed answers.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TYPESAFE_API_KEY ||= "test";
const { extract, parseFields, parseNumber, valueOfLine } = await import("../src/jev.js");

test("parseFields accepts both shorthand and typed specs and rejects bad input", () => {
  assert.deepEqual(parseFields({ title: "book title", price: { type: "number" } }).map((f) => [f.name, f.type]), [["title", "string"], ["price", "number"]]);
  assert.throws(() => parseFields({ x: { type: "date" } }), /type/);
  assert.throws(() => parseFields([]), /object/);
  assert.throws(() => parseFields({}), /1 to 20/);
});

test("numbers parse from money, thousands and percent tokens", () => {
  assert.equal(parseNumber("$1,299.50"), 1299.5);
  assert.equal(parseNumber("£51.77"), 51.77);
  assert.equal(parseNumber("42%"), 42);
  assert.equal(parseNumber("3.9", true), 3);
  assert.equal(parseNumber("14,99 €"), 14.99, "decimal comma");
  assert.equal(parseNumber("1.234,50"), 1234.5, "European thousands");
  assert.equal(parseNumber("1,299"), 1299);
});

test("a hyphen between digits is a separator, not a minus sign", async () => {
  let offered;
  globalThis.fetch = async (_u, { body }) => {
    const { questions } = JSON.parse(body); offered = Object.keys(questions.f0.criteria);
    return new Response(JSON.stringify({ answers: { f0: { choice: offered[0], probabilities: Object.fromEntries(offered.map((k, i) => [k, i ? 0 : 1])) } } }));
  };
  await extract({ n: { type: "number", description: "phone" } }, ["Call 555-1234, ages 10-20, balance -5"]);
  assert.deepEqual(offered.slice(0, -1).sort(), ["-5", "10", "1234", "20", "555"]); // object keys: integer-like ones come first
});

test("a Label: value line is cut to its value only when the label is about the field", () => {
  const f = { name: "price", description: "the product price" };
  assert.equal(valueOfLine("Price: $14.99", f), "$14.99");
  assert.equal(valueOfLine("Note: ships in 2 days", f), "Note: ships in 2 days");
});

test("extract asks one request and copies the picked values", async () => {
  const lines = ["Logitech M185 Wireless Mouse", "Price: $14.99", "Rating 4.5 of 5", "In stock"];
  let calls = 0;
  globalThis.fetch = async (_u, { body }) => {
    calls++;
    const { questions } = JSON.parse(body);
    const pick = (q, k) => ({ choice: k, probabilities: Object.fromEntries(Object.keys(q.criteria).map((c) => [c, c === k ? 1 : 0])) });
    return new Response(JSON.stringify({ answers: { f0: pick(questions.f0, "L0000"), f1: pick(questions.f1, "$14.99"), f2: { noul: 0.9 }, f3: pick(questions.f3, "(not on page)") }, usage: { input_tokens: 1 } }));
  };
  const r = await extract({ name: "product name", price: { type: "number", description: "price" }, in_stock: { type: "boolean", description: "in stock" }, sku: "SKU code" }, lines);
  assert.equal(calls, 1);
  assert.deepEqual(r.data, { name: "Logitech M185 Wireless Mouse", price: 14.99, in_stock: true, sku: null });
  assert.equal(r.confidence.in_stock, 0.8);
});

test("evidence joins a label line with the value on the next line", async () => {
  const { evidence } = await import("../src/jev.js");
  globalThis.fetch = async (_u, { body }) => {
    const { questions } = JSON.parse(body);
    const ids = Object.keys(questions.where.criteria);
    return new Response(JSON.stringify({ answers: { where: { choice: ids[1], probabilities: Object.fromEntries(ids.map((k, i) => [k, i === 1 ? 1 : 0])) }, exists: { noul: 0.9 } } }));
  };
  const r = await evidence("report its license", ["bert-base-uncased", "License:", "apache-2.0", "Downloads"]);
  assert.equal(r.lines[0].line, "License: apache-2.0");
});

test("a list field is one Noul per line: kept lines in page order, deduplicated, labels stripped", async () => {
  const { listFrom } = await import("../src/jev.js");
  const lines = ["Top posts", "Post A", "Post B", "Post A", "Footer"];
  const [items, conf] = listFrom([[2, 0.9], [1, 0.95], [3, 0.9], [0, 0.05], [4, 0.1]], lines);
  assert.deepEqual(items, ["Post A", "Post B"]);
  assert.equal(conf, 0.84);
  globalThis.fetch = async (_u, { body }) => {
    const { questions } = JSON.parse(body);
    const answers = Object.fromEntries(Object.keys(questions).map((id) => [id, { noul: /L000[12]$/.test(id) ? 0.9 : 0.05 }]));
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 1 } }));
  };
  const r = await extract({ capitals: { type: "list", description: "capital cities" } }, ["Countries", "Capital: Kabul", "Capital: Tirana", "Footer"]);
  assert.deepEqual(r.data.capitals, ["Kabul", "Tirana"]);
  assert.deepEqual((await extract({ capitals: { type: "list" } }, [])).data.capitals, []);
});
