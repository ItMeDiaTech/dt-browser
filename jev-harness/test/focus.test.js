// Live (Chrome): typing refuses to send text when a focus trap takes the keyboard from the field.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { StalePage, Tab } from "../src/browser.js";

test("clearing events cannot redirect subsequent typing into another control", async () => {
  for (const editable of [false, true]) {
    const document = { activeElement: null, getSelection: () => ({ selectAllChildren() {} }) };
    const decoy = { value: "" };
    class Field {
      constructor() { this.value = "old"; this.ownerDocument = document; this.tagName = "INPUT"; this.isContentEditable = editable; }
      focus() { document.activeElement = this; }
      getRootNode() { return document; }
      dispatchEvent() { document.activeElement = decoy; }
      get value() { return this.text || ""; }
      set value(text) { this.text = text; }
    }
    const field = new Field();
    document.defaultView = { HTMLInputElement: Field };
    document.execCommand = () => { field.value = ""; document.activeElement = decoy; };
    const context = vm.createContext({ window: { __jev: [field] }, document, location: { href: "https://fixture.test/" }, Event: class {} });
    const tab = Object.create(Tab.prototype);
    tab.targets = [{ session: null, local: 1 }];
    tab.locate = async () => ({});
    tab.cdp = { send: async (method, params) => {
      if (method === "Input.insertText") { document.activeElement.value += params.text; return {}; }
      assert.equal(method, "Runtime.evaluate");
      return { result: { value: vm.runInContext(params.expression, context) } };
    } };
    await assert.rejects(tab.type(1, "fixture value"), StalePage);
    assert.equal(decoy.value, "");
  }
});

test("a focus trap cannot redirect typed text, such as a stored password, into another field", async () => {
  const html = `<form><input type=password id=pw aria-label=Password><input id=user aria-label=User></form>
    <div id=modal><input id=news aria-label="Newsletter email"></div><script>
    document.addEventListener('focusin', (e) => { if (e.target.id === 'pw') document.getElementById('news').focus(); });
    </script>`;
  const tab = await Tab.open();
  try {
    await tab.goto("data:text/html," + encodeURIComponent(html));
    const page = await tab.observe();
    await assert.rejects(tab.type(page.elements.find((e) => e.kind === "secret").i, "hunter2"), StalePage);
    assert.deepEqual(await tab.evaluate("[pw.value, news.value]"), ["", ""]);
    await tab.type(page.elements.find((e) => e.label === "User").i, "ada");
    assert.equal(await tab.evaluate("user.value"), "ada", "a field that keeps focus is still typed into");
  } finally { await tab.close(); }
});
