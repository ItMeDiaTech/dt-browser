import { test } from 'node:test';
import assert from 'node:assert/strict';

test('isolated live relay keeps concurrent tabs and detached state, then reconnects', {
  skip: process.env.DT_BROWSER_E2E !== '1' ? 'requires the isolated browser_workflow_e2e.py runner' : false,
  timeout: 100_000,
}, async () => {
  const bridge = new URL(process.env.JEV_BRIDGE || 'invalid:');
  const site = new URL(process.env.BENCH_SITE || 'invalid:');
  assert.equal(bridge.protocol, 'ws:');
  assert.equal(bridge.hostname, '127.0.0.1');
  assert.ok(bridge.port && bridge.port !== '18765', 'requires an isolated bridge port');
  assert.equal(site.protocol, 'http:');
  assert.equal(site.hostname, '127.0.0.1');
  assert.ok(site.port && site.pathname === '/' && !site.search && !site.hash);
  assert.match(process.env.DT_BRIDGE_TOKEN || '', /^[a-f0-9]{64}$/);
  const { Tab, bridged } = await import('../src/browser.js');
  assert.equal(bridged, true);
  const tabs = new Set();
  const open = async () => { const tab = await Tab.open(); tabs.add(tab); assert.ok(tab.owned && tab.created); return tab; };
  try {
    const opened = await Promise.allSettled([open(), open()]);
    for (const result of opened) assert.equal(result.status, 'fulfilled', result.reason?.stack);
    let [first, second] = opened.map((result) => result.value);
    assert.notEqual(first.tabId, second.tabId);
    const firstId = first.tabId, secondId = second.tabId, link = first.cdp.link;
    await Promise.all([first.goto(`${site.origin}/workflow.html`), second.goto(`${site.origin}/workflow.html`)]);
    const snapshots = await Promise.all([first.observe(), second.observe()]);
    const fields = snapshots.map((snapshot) => {
      const matches = snapshot.elements.filter((element) => element.label === 'Plain text' || element.label.startsWith('Plain text — '));
      assert.equal(matches.length, 1);
      return matches[0].i;
    });
    const activeTabs = async () => (await link.command('list_tabs')).filter((tab) => tab.active).map((tab) => tab.id).sort();
    const activeBefore = await activeTabs();
    assert.equal(await first.evaluate('document.hasFocus()'), true, 'background input receives focus emulation');
    await first.click(fields[0]);
    assert.deepEqual(await activeTabs(), activeBefore, 'trusted input must not activate a background tab');
    await Promise.all([first.type(fields[0], 'First relay tab café\n中文 🦊'), second.type(fields[1], 'Second relay tab Ω')]);
    assert.equal(await first.evaluate('plain.value'), 'First relay tab café\n中文 🦊');
    assert.equal(await second.evaluate('plain.value'), 'Second relay tab Ω');
    await first.detach();
    assert.equal(first.cdp.open, false);
    assert.ok((await link.command('list_tabs')).some((tab) => tab.id === firstId));
    first = await first.reattach(); tabs.add(first);
    assert.equal(first.tabId, firstId);
    assert.equal(first.snap, snapshots[0].snap);
    await first.type(fields[0], 'Reattached with preserved index ✓');
    assert.equal(await first.evaluate('plain.value'), 'Reattached with preserved index ✓');
    assert.equal(await second.evaluate('plain.value'), 'Second relay tab Ω');
    await first.close(); tabs.delete(first);
    assert.ok(!(await link.command('list_tabs')).some((tab) => tab.id === firstId));
    await second.close(); tabs.delete(second);
    const third = await open();
    assert.notEqual(third.cdp.link, link, 'last closed tab releases the shared link');
    const remaining = await third.cdp.link.command('list_tabs');
    assert.ok(!remaining.some((tab) => tab.id === firstId || tab.id === secondId));
    await third.goto(`${site.origin}/index.html`);
    assert.equal(await third.evaluate('document.title'), 'dt-browser E2E Test Page');
    // A target=_blank popup of this background tab: Chrome's openerTabId names the active tab
    // instead, so only the extension's dtb.tabOpened report finds it.
    await third.evaluate(`document.body.insertAdjacentHTML('beforeend', '<a id="pop" href="/index.html#popup" target="_blank">Open popup</a>')`);
    const anchor = (await third.observe()).elements.find((element) => element.label.includes('Open popup'));
    assert.ok(anchor, 'the popup link is observed');
    const before = await third.pageTargets();
    await third.click(anchor.i);
    let popup = null;
    for (let i = 0; i < 20 && !popup; i++) popup = await third.adoptPopup(before) ?? (await new Promise((r) => setTimeout(r, 100)), null);
    assert.ok(popup, 'the popup is adopted');
    tabs.delete(third); tabs.add(popup);
    assert.ok(popup.owned, 'a popup of a relay tab is the relay\'s own');
    assert.equal(new URL(await popup.evaluate('location.href')).hash, '#popup');
    await popup.close(); tabs.delete(popup);
    const check = await open(); // the popup was the last tab, so its link is gone
    assert.ok(!(await check.cdp.link.command('list_tabs')).some((tab) => tab.id === popup.tabId), 'an owned popup is closed, not left open');
    await check.close(); tabs.delete(check);
  } finally {
    await Promise.all([...tabs].filter((tab) => tab.cdp.open).map((tab) => tab.close()));
  }
});
