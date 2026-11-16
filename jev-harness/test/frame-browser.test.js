// Synthetic pages, an isolated CDP port/profile, no model or standing bridge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });

function loadFrame(frame, url) {
  return new Promise((resolve, reject) => {
    const loaded = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      frame.removeEventListener("load", loaded);
      reject(new Error("synthetic frame load timed out"));
    }, 5000);
    frame.addEventListener("load", loaded, { once: true });
    frame.src = url;
  });
}

test("frame fixture waits for the requested load, including an immediate cached load", async () => {
  for (const immediate of [false, true]) {
    const frame = new EventTarget();
    let requested, ready = false;
    Object.defineProperty(frame, "src", { set(url) {
      requested = url;
      if (immediate) frame.dispatchEvent(new Event("load"));
    } });
    const loading = loadFrame(frame, "/child?new-document").then(() => { ready = true; });
    assert.equal(requested, "/child?new-document");
    await Promise.resolve();
    assert.equal(ready, immediate, "an old document's visible controls cannot satisfy a pending load");
    if (!immediate) frame.dispatchEvent(new Event("load"));
    await loading;
    assert.equal(ready, true);
  }
});

test("isolated Chrome interacts with same-/cross-origin frames and rejects navigated/detached IDs", { timeout: 60000 }, async (t) => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end(request.url.startsWith("/child")
      ? '<input aria-label="Frame message"><select aria-label="Frame color"><option>Red</option><option>Blue</option></select><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Apply frame</button><output></output>'
      : '<input aria-label="Decoy"><iframe id="child"></iframe>');
  });
  await listen(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const reservation = createServer();
  await listen(reservation);
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const profile = resolve(mkdtempSync(join(tmpdir(), "dt-browser-frames-")));
  delete process.env.JEV_BRIDGE;
  Object.assign(process.env, { JEV_CDP_PORT: String(port), JEV_PROFILE: profile, JEV_HEADLESS: "1" });
  const version = () => fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) }).then((r) => r.json()).catch(() => null);
  let tab;
  try {
    const { StalePage, Tab, bridged } = await import("../src/browser.js");
    assert.equal(bridged, false);
    tab = await Tab.open();
    t.diagnostic("isolated Chrome attached");
    const pick = async (label) => {
      const element = (await tab.observe()).elements.find((e) => e.label === label || e.label.startsWith(`${label} — `));
      assert.ok(element, `missing ${label}`);
      return element;
    };
    for (const crossOrigin of [false, true]) {
      t.diagnostic(`testing ${crossOrigin ? "cross-origin" : "same-origin"} frame`);
      await tab.goto(base);
      const child = new URL("/child", base);
      if (crossOrigin) child.hostname = "localhost";
      // A control label can still belong to the previous document while src navigation is pending.
      await tab.evaluate(`(${loadFrame})(document.querySelector('#child'), ${JSON.stringify(child.href)})`);
      let page;
      for (let attempt = 0; attempt < 60; attempt++) {
        page = await tab.observe();
        if (page.elements.some((e) => e.label === "Frame message" && !!e.frame === crossOrigin)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const field = page.elements.find((e) => e.label === "Frame message" && !!e.frame === crossOrigin);
      assert.ok(field, "frame control must be indexed via its document or CDP session");
      const target = tab.target(field.i);
      const facts = await tab.evaluate(`(() => { const el = window.__jev?.[${target.local - 1}];
        return { snapshotMatches: window.__jevSnap === ${JSON.stringify(target.snap)}, connected: !!el?.isConnected,
          loaded: el?.ownerDocument.readyState === 'complete', requestedDocument: el?.ownerDocument.URL === ${JSON.stringify(child.href)},
          attachedDocument: !!el && (el.ownerDocument === document || el.ownerDocument.defaultView?.frameElement?.contentDocument === el.ownerDocument) }; })()`, target.session);
      t.diagnostic(`frame document facts: ${JSON.stringify(facts)}`);
      assert.deepEqual(facts, { snapshotMatches: true, connected: true, loaded: true, requestedDocument: true, attachedDocument: true });
      t.diagnostic("frame indexed");
      await tab.type(field.i, "Synthetic message");
      t.diagnostic("frame typed");
      await tab.select(page.elements.find((e) => e.label === "Frame color").i, "Blue");
      await tab.click(page.elements.find((e) => e.label.startsWith("Apply frame")).i);
      await tab.settle();
      t.diagnostic("frame applied");
      assert.equal(await tab.evaluate(tab.elementExpression(field.i, 'el.ownerDocument.querySelector("output").textContent'), target.session), "Synthetic message");
      assert.ok((await tab.observe()).lines.some((line) => line.includes("Synthetic message")));
      assert.equal(await tab.evaluate('document.querySelector("input").value'), "", "decoy stays untouched");
      const stale = await pick("Frame color");
      if (crossOrigin) {
        const previous = tab;
        previous.cdp.close();
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const target = targets.find((target) => target.id === previous.targetId);
        assert.ok(target, "isolated tab must survive transport detachment");
        tab = await Tab.attach(target);
        await tab.restoreSnapshot(previous);
        await tab.select(stale.i, "Red");
        t.diagnostic("unchanged iframe index survived CDP reattachment");
      }
      child.search = "?replacement";
      await tab.evaluate(`(${loadFrame})(document.querySelector('#child'), ${JSON.stringify(child.href)})`);
      await assert.rejects(tab.select(stale.i, "Blue"), StalePage);
      t.diagnostic("navigation rejected stale index");
      const detached = await pick("Frame color");
      await tab.evaluate('document.querySelector("#child").remove()');
      await assert.rejects(tab.select(detached.i, "Blue"), StalePage);
      t.diagnostic("detachment rejected stale index");
    }
  } finally {
    // Close only the browser on our reserved port, including when initial Tab setup failed.
    const browser = await version();
    try {
      if (browser) {
        assert.equal(new URL(browser.webSocketDebuggerUrl).host, `127.0.0.1:${port}`);
        await new Promise((resolve, reject) => {
          const socket = new WebSocket(browser.webSocketDebuggerUrl);
          const finish = (error) => { clearTimeout(timer); socket.close(); error ? reject(error) : resolve(); };
          const timer = setTimeout(() => finish(new Error("isolated Chrome did not close")), 3000);
          socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
          socket.onmessage = socket.onclose = () => finish();
          socket.onerror = () => finish(new Error("could not close isolated Chrome"));
        });
      }
      for (let attempt = 0; attempt < 30 && await version(); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(await version(), null);
      assert.equal(dirname(profile), resolve(tmpdir()));
      assert.ok(basename(profile).startsWith("dt-browser-frames-"));
      await rm(profile, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    } finally {
      tab?.cdp.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

// Chrome outlives a tab close on purpose so several harness processes can share one browser. The
// leak is that nothing ever ended it: each run left a whole Chrome (and ~180 MB of profile) behind,
// which filled a temp volume after 18 runs. Reclaim only this process's own launch, and only on its
// last tab, so a second harness sharing the browser keeps working.
test("closing the last tab reclaims Chrome, closing one of two leaves it for the other run", { timeout: 60000 }, async (t) => {
  const reservation = createServer();
  await listen(reservation);
  const port = reservation.address().port;
  await new Promise((resolveClose) => reservation.close(resolveClose));
  const profile = resolve(mkdtempSync(join(tmpdir(), "dt-browser-reclaim-")));
  const host = ["127", "0", "0", "1"].join(".");
  delete process.env.JEV_BRIDGE;
  Object.assign(process.env, { JEV_CDP_PORT: String(port), JEV_PROFILE: profile, JEV_HEADLESS: "1" });
  // An invalid URL makes fetch throw synchronously, before any .catch runs, so wrap the call itself.
  const probe = () => Promise.resolve().then(() => fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(800) })).catch(() => null);
  const alive = async () => !!(await probe());
  // A failed assertion must not leak Chrome: 18 leaked browsers (108 processes) filled a temp volume
  // while this bug was measured. Browser.close over CDP ends the browser on every platform.
  const forceClose = async () => {
    const info = await probe().then((r) => r?.json()).catch(() => null);
    if (!info?.webSocketDebuggerUrl) return;
    await new Promise((done) => {
      const socket = new WebSocket(info.webSocketDebuggerUrl);
      const finish = () => { try { socket.close(); } catch {} done(); };
      const timer = setTimeout(finish, 3000);
      socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
      socket.onmessage = socket.onclose = () => { clearTimeout(timer); finish(); };
      socket.onerror = finish;
    });
  };
  // A fresh module instance: browser.js reads JEV_CDP_PORT once at load, so the earlier test in this
  // file already fixed it to its own port and this test would drive the wrong Chrome.
  const { Tab } = await import("../src/browser.js?reclaim");
  let first, second;
  try {
    first = await Tab.open();
    second = await Tab.open();
    assert.equal(await alive(), true, "the harness launched Chrome");
    await first.close();
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await alive(), true, "a tab still open in another run keeps Chrome alive");
    assert.equal(await second.evaluate("1+1"), 2, "the remaining tab is still usable");
    await second.close();
    for (let attempt = 0; attempt < 40 && await alive(); attempt++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(await alive(), false, "the last tab close reclaims the Chrome this process launched");
    t.diagnostic("chrome reclaimed after the last tab");
  } finally {
    await forceClose();
    for (let attempt = 0; attempt < 30 && await alive(); attempt++) await new Promise((r) => setTimeout(r, 100));
    await rm(profile, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }).catch(() => {});
  }
});
