import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.JEV_HOME = mkdtempSync(join(tmpdir(), "jev-mem-"));
delete process.env.JEV_NO_MEMORY;
const { forgetSearch, locateQuery, match, recall, remember, searchUrl, searchUrlFrom, learnSearch, templatize, touch } = await import("../src/memory.js");

const SEARCH = [
  { op: "type", role: "searchbox", label: "Search products", text: "wireless mouse", submit: true },
  { op: "click", role: "link", label: "Logitech M185 Wireless Mouse" },
];
const GOAL = "Search the store for wireless mouse, open the Logitech M185 product page and report its price.";

test("templatize cuts typed text and the named item out of the goal", () => {
  const t = templatize(GOAL, SEARCH);
  assert.equal(t.template, "Search the store for {0}, open the {1} product page and report its price.");
  assert.equal(t.steps[0].text, "{0}");
  assert.deepEqual([t.steps[1].label, t.steps[1].slot], ["{1} Wireless Mouse", 1]);
});

test("templatize refuses plans that use no goal value", () => {
  assert.equal(templatize("Sort the results by price from low to high.", [{ op: "select", role: "select", label: "Sort", option: "Price: low to high" }]), null);
});

test("match binds slot values and rejects other wording", () => {
  const tpl = "Search the store for {0}, open the {1} product page and report its price.";
  assert.deepEqual(match(tpl, "search the store for  usb hub, open the Anker 7-in-1 product page and report its price"), ["usb hub", "Anker 7-in-1"]);
  assert.equal(match(tpl, "Search the store for usb hub and add it to the cart."), null);
});

test("a remembered plan replays for a new goal of the same shape, with values swapped", () => {
  remember("http://shop.test/index.html", GOAL, SEARCH);
  assert.equal(recall("http://shop.test/", GOAL).template, undefined, "exact goal: exact plan");
  const p = recall("http://shop.test/", "Search the store for usb hub, open the Anker 7-in-1 USB-C Hub product page and report its price.");
  assert.deepEqual(p.values, ["usb hub", "Anker 7-in-1 USB-C Hub"]);
  assert.equal(p.steps[0].text, "usb hub");
  assert.equal(p.steps[1].contains, "Anker 7-in-1 USB-C Hub");
  assert.equal(recall("http://other.test/", "Search the store for usb hub, open the X1 product page and report its price."), null, "other site");
});

test("search URLs are learned from the query parameter or path segment and refilled", () => {
  const box = { role: "searchbox", label: "Search products", search: true };
  assert.deepEqual(locateQuery("https://a.test/results.html?cat=all&q=wireless+mouse", "Wireless Mouse"), { param: "q" });
  assert.deepEqual(locateQuery("https://a.test/search/wireless%20mouse/", "wireless mouse"), { segment: 2 });
  assert.equal(locateQuery("https://a.test/results.html?id=7", "mouse"), null);
  assert.equal(searchUrlFrom({ url: "https://a.test/search/x/?p=1", segment: 2 }, "usb hub"), "https://a.test/search/usb%20hub/");
  assert.ok(learnSearch("https://a.test/", "https://a.test/results.html?cat=all&q=wireless+mouse&sid=8f3a9c21&page=2", box, "wireless mouse"));
  assert.equal(searchUrl("https://a.test/other", box, "usb hub"), "https://a.test/results.html?cat=all&q=usb+hub", "ids and page numbers dropped");
  assert.equal(searchUrl("https://a.test/", { role: "textbox", label: "Search products" }, "usb hub"), null, "another field on the site");
  assert.ok(!learnSearch("https://b.test/", "https://b.test/sub?email=a%40b.com", { role: "textbox", label: "Email" }, "a@b.com"), "not a search field");
  assert.ok(!learnSearch("https://a.test/", "https://b.test/?q=x", box, "x"), "cross-site navigation is not learned");
  forgetSearch({ url: "https://a.test/", e: box });
  assert.equal(searchUrl("https://a.test/", box, "usb hub"), null, "forgotten");
});

test("a template binding must name one item: short generic values do not bind a clicked label", () => {
  remember("http://cart.test/", "Search for usb hub and add the Anker 7-in-1 USB-C Hub to the cart.",
    [{ op: "type", role: "searchbox", label: "Search", text: "usb hub", submit: true }, { op: "click", role: "button", label: "Add to cart — Anker 7-in-1 USB-C Hub" }]);
  assert.equal(recall("http://cart.test/", "Search for mouse and add the a to the cart."), null);
  assert.ok(recall("http://cart.test/", "Search for mouse and add the Logitech M330 to the cart."));
});

test("slot values are cut at word boundaries only", () => {
  assert.equal(templatize("Show ordered items that are red", [{ op: "type", role: "textbox", label: "Color", text: "red" }])?.template,
    "Show ordered items that are {0}");
});

test("case and repeated whitespace in goal values never reuse different input text", () => {
  const url = "https://literal.test/";
  remember(url, 'Fill the code with "ABC".', [{ op: "type", role: "textbox", label: "Code", text: "ABC" }]);
  const casePlan = recall(url, 'Fill the code with "abc".');
  assert.ok(!casePlan || casePlan.steps[0].text === "abc");
  remember(url, 'Fill the code with "a b".', [{ op: "type", role: "textbox", label: "Code", text: "a b" }]);
  const spacePlan = recall(url, 'Fill the code with "a  b".');
  assert.ok(!spacePlan || spacePlan.steps[0].text === "a  b");
});

test("case-distinct values keep their fields when recorded steps run in reverse order", () => {
  const url = "https://reversed-values.test/";
  remember(url, 'Fill the first field with "abc" and the second field with "ABC".', [
    { op: "type", role: "textbox", label: "Second field", text: "ABC" },
    { op: "type", role: "textbox", label: "First field", text: "abc" },
  ]);
  const plan = recall(url, 'Fill the first field with "foo" and the second field with "bar".');
  assert.ok(plan);
  assert.deepEqual(plan.steps.map((step) => [step.label, step.text]), [["Second field", "bar"], ["First field", "foo"]]);
});

test("template bindings preserve spaces inside a quoted value", () => {
  const url = "https://quoted-space.test/";
  remember(url, 'Fill the code with "ABC".', [{ op: "type", role: "textbox", label: "Code", text: "ABC" }]);
  const plan = recall(url, 'Fill the code with " abc ".');
  assert.ok(plan);
  assert.equal(plan.steps[0].text, " abc ");
});

test("independent processes preserve all distinct cached plans", async () => {
  const home = mkdtempSync(join(tmpdir(), "jev-shared-cache-"));
  const module = new URL("../src/memory.js", import.meta.url).href;
  const childRun = (source) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { env: { ...process.env, JEV_HOME: home }, stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", (data) => { error += data; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(error)));
  });
  await Promise.all(Array.from({ length: 4 }, (_, index) => childRun(`import { remember } from ${JSON.stringify(module)}; for(let n=0;n<12;n++) remember('https://shared.test/', 'workflow '+${index}+' '+n, [{op:'click',role:'button',label:'Continue'}]);`)));
  await childRun(`import assert from 'node:assert/strict'; import { recall } from ${JSON.stringify(module)}; for(let i=0;i<4;i++) for(let n=0;n<12;n++) assert.ok(recall('https://shared.test/','workflow '+i+' '+n));`);
});

test("cache write failure cannot turn a remembered browser result into an error", async () => {
  const home = join(mkdtempSync(join(tmpdir(), "jev-blocked-cache-")), "file");
  writeFileSync(home, "not a directory");
  const module = new URL("../src/memory.js", import.meta.url).href;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import {remember} from ${JSON.stringify(module)}; remember('https://disk.test/','Complete workflow.',[{op:'click',role:'button',label:'Continue'}]);`],
      { env: { ...process.env, JEV_HOME: home }, stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", (data) => { error += data; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(error)));
  });
});

test("a corrupt cache entry leaves other plans usable and storage stays bounded", () => {
  const url = "https://bounded.test/";
  for (let i = 0; i < 505; i++) remember(url, `bounded workflow ${i}`, [{ op: "click", role: "button", label: "Continue" }]);
  const cache = join(process.env.JEV_HOME, "plans-v2");
  assert.ok(readdirSync(cache).filter((name) => name.endsWith(".json")).length <= 500);
  writeFileSync(join(cache, `${"f".repeat(64)}.json`), "{bad json");
  assert.ok(recall(url, "bounded workflow 504"));
});

test("malformed cached steps and search URLs are ignored", () => {
  remember("https://corrupt.test/", "unsafe workflow", [{ op: "click", role: "button", label: "Continue" }]);
  const cache = join(process.env.JEV_HOME, "plans-v2");
  const write = (key, value) => writeFileSync(join(cache, `${createHash("sha256").update(key).digest("hex")}.json`), JSON.stringify({ key, value }));
  write("corrupt.test|unsafe workflow", { steps: [null] });
  assert.equal(recall("https://corrupt.test/", "unsafe workflow"), null);
  write("search|corrupt.test|searchbox|Search", { url: "not a URL", param: "q" });
  assert.equal(searchUrl("https://corrupt.test/", { role: "searchbox", label: "Search", search: true }, "query"), null);
});

test("a plan that keeps verifying by replay survives eviction of newer one-off plans", () => {
  const url = "https://favourite.test/", goal = "open the favourite page and report its title";
  remember(url, goal, SEARCH);
  remember("https://unused.test/", "open the unused page and report its title", SEARCH);
  const once = (from, to) => { for (let i = from; i < to; i++) remember(`https://once${i}.test/`, `do one-off thing number ${i}`, SEARCH); };
  once(0, 300);
  touch(recall(url, goal).key); // what a verified replay does: it rewrites nothing
  once(300, 600);
  assert.ok(recall(url, goal), "the replayed plan was kept");
  assert.equal(recall("https://unused.test/", "open the unused page and report its title"), null, "an unused plan of the same age was evicted");
});

test("using a learned search URL marks it recent, so eviction keeps it", () => {
  const e = { role: "searchbox", label: "Search books", search: true };
  assert.ok(learnSearch("https://books.test/", "https://books.test/find?q=dune", e, "dune"));
  const once = (from, to) => { for (let i = from; i < to; i++) remember(`https://later${i}.test/`, `do a later thing number ${i}`, SEARCH); };
  once(0, 300);
  assert.ok(searchUrl("https://books.test/", e, "solaris"));
  once(300, 600);
  assert.equal(searchUrl("https://books.test/", e, "solaris"), "https://books.test/find?q=solaris");
});
