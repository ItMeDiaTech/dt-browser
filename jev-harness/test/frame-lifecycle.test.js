import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { StalePage, Tab } from "../src/browser.js";

// The CDP boundary is synthetic; old documents can retain connected nodes after frame navigation.
async function fixture() {
  let changes = 0;
  const document = {}, childDocument = { defaultView: {} };
  const owner = { isConnected: true, contentDocument: childDocument, ownerDocument: document };
  childDocument.defaultView.frameElement = owner;
  const field = (doc) => ({ isConnected: true, ownerDocument: doc, options: [{ text: "Blue", value: "blue" }], dispatchEvent: () => { changes++; } });
  const main = { document, location: { href: "https://fixture.test/", hostname: "fixture.test" }, Event: class {} };
  main.window = { __jevSnap: "main", __jev: [field(childDocument)] };
  const sub = { document: {}, location: { href: "https://other.test/", hostname: "other.test" }, Event: class {} };
  sub.window = { __jevSnap: "frame", __jev: [field(sub.document)] };
  const tab = new Tab();
  tab.frames = new Map([["child", { targetId: "frame-id" }]]);
  tab.frameOrigin = async () => ({ x: 0, y: 0, width: 200, height: 100, vw: 1000, vh: 1000 });
  tab.cdp = { send: async (method, params, _timeout, session) => {
    assert.equal(method, "Runtime.evaluate");
    try { return { result: { value: vm.runInNewContext(params.expression, session ? sub : main) } }; }
    catch (error) { return { exceptionDetails: { exception: { description: error.message } } }; }
  } };
  const evaluate = tab.evaluate;
  tab.evaluate = async (_expression, session) => ({ snap: session ? "frame" : "main", url: session ? sub.location.href : main.location.href,
    elements: [{ i: 1, kind: "select", role: "select", label: "Color" }], lines: [], scroll: { y: 0, max: 0 } });
  await tab.observe();
  tab.evaluate = evaluate;
  return { tab, main, sub, owner, childDocument, changes: () => changes };
}

test("same-origin and cross-origin frame selects use their original document", async () => {
  const f = await fixture();
  await f.tab.select(1, "Blue");
  await f.tab.select(2, "Blue");
  assert.equal(f.changes(), 4);
});

test("a navigated cross-origin frame cannot reuse an old index for its replacement control", async () => {
  for (const action of [(tab) => tab.select(2, "Blue"), (tab) => tab.click(2), (tab) => tab.type(2, "Synthetic"), (tab) => tab.upload(2, ["synthetic.txt"])]) {
    const f = await fixture();
    f.sub.window.__jevSnap = "replacement";
    await assert.rejects(action(f.tab), StalePage);
    assert.equal(f.changes(), 0);
  }
});

test("frame changes after dispatched input do not request an action retry", async () => {
  const tab = new Tab();
  tab.targets = [{ session: null, local: 1, snap: "fixture" }];
  tab.assertAllowed = async () => {};
  tab.locate = async () => ({ x: 1, y: 1, covered: false, editContext: true });
  let inputs = 0;
  tab.cdp = { send: async () => { inputs++; } };
  tab.evaluateElement = async () => { throw new StalePage("fixture changed"); };
  await assert.rejects(tab.click(1), (error) => !(error instanceof StalePage) && /clicked element changed/.test(error.message));
  assert.equal(inputs, 3);
  let evaluations = 0;
  tab.evaluateElement = async () => { if (++evaluations > 1) throw new StalePage("fixture changed"); return true; };
  tab.insert = async () => { inputs++; };
  await assert.rejects(tab.type(1, "Synthetic"), (error) => !(error instanceof StalePage) && /text may already be entered/.test(error.message));
  assert.equal(inputs, 4);
});

test("a navigated or detached same-origin frame's retained nodes cannot receive input", async () => {
  for (const detach of [false, true]) {
    const f = await fixture();
    if (detach) f.owner.isConnected = false;
    else f.owner.contentDocument = {};
    await assert.rejects(f.tab.select(1, "Blue"), StalePage);
    assert.equal(f.changes(), 0);
  }
});

test("detached and replaced CDP frame sessions invalidate old frame IDs", async () => {
  for (const replace of [false, true]) {
    const f = await fixture();
    if (replace) f.tab.frames.set("child", { targetId: "replacement-id" });
    else f.tab.frames.delete("child");
    await assert.rejects(f.tab.select(2, "Blue"), StalePage);
    assert.equal(f.changes(), 0);
  }
});

test("a nested frame is stale as soon as its ancestor CDP session detaches", async () => {
  const f = await fixture();
  f.tab.frames.set("parent", { targetId: "parent-id" });
  f.tab.frames.get("child").parent = "parent";
  f.tab.frames.delete("parent");
  await assert.rejects(f.tab.select(2, "Blue"), StalePage);
  assert.equal(f.changes(), 0);
});

test("reattachment binds unchanged frame targets to fresh CDP sessions, never by URL", async () => {
  const f = await fixture();
  const previous = { snap: f.tab.snap, targets: f.tab.targets, elements: f.tab.elements };
  const frame = f.tab.frames.get("child");
  f.tab.frames = new Map([["fresh-session", frame]]);
  await f.tab.restoreSnapshot(previous);
  assert.equal(f.tab.target(2).session, "fresh-session");
  await f.tab.select(2, "Blue");
  assert.equal(f.changes(), 2);

  f.sub.window.__jevSnap = "new-frame-document";
  await assert.rejects(f.tab.select(2, "Blue"), StalePage);
  assert.equal(f.changes(), 2, "same target with a different document remains stale");

  f.tab.frames = new Map([["another-session", { targetId: "different-frame" }]]);
  await f.tab.restoreSnapshot(previous);
  await assert.rejects(f.tab.select(2, "Blue"), StalePage);
  assert.equal(f.changes(), 2);
});

test("reattachment does not restore indices when the main document snapshot changed", async () => {
  const f = await fixture();
  const previous = { snap: "old-main", targets: f.tab.targets, elements: f.tab.elements };
  delete f.tab.targets;
  await f.tab.restoreSnapshot(previous);
  assert.throws(() => f.tab.target(1), StalePage);
});
