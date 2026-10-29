// Playwright through the bridge's CDP endpoint (bridge/cdp_endpoint.py): connect, open a page,
// type, click, follow a popup, close. Run by scripts/browser_workflow_e2e.py against test Chrome.
// Usage: node playwright_cdp_check.cjs <endpoint> <site>   (DT_BRIDGE_TOKEN set; playwright on NODE_PATH)
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

(async () => {
  const [endpoint, site] = process.argv.slice(2);
  const unauthorized = await chromium.connectOverCDP(endpoint, { timeout: 5000 }).then(() => null, (e) => e);
  assert.ok(unauthorized, 'a client without the token is refused');
  const browser = await chromium.connectOverCDP(endpoint, { headers: { Authorization: `Bearer ${process.env.DT_BRIDGE_TOKEN}` } });
  const [context] = browser.contexts();
  const page = await context.newPage();
  await page.goto(`${site}/index.html`);
  assert.equal(await page.textContent('#h1'), 'Sidecar Monkey E2E');
  await page.fill('#inp', 'typed by playwright');
  assert.equal(await page.inputValue('#inp'), 'typed by playwright');
  await page.click('#btn');
  assert.equal(await page.textContent('#counter'), 'counter: 1');
  // A real Chrome blocks window.open without a user gesture; a clicked target=_blank link is one.
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<a id="pop" href="/index.html#popup" target="_blank">popup</a>'));
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#pop')]);
  await popup.waitForLoadState();
  assert.equal(new URL(popup.url()).hash, '#popup');
  assert.equal(await popup.textContent('#h1'), 'Sidecar Monkey E2E');
  assert.ok((await context.cookies()).every((c) => typeof c.name === 'string'), 'browser-level Storage commands answer');
  await popup.close();
  await page.close();
  await browser.close();
  console.log('PASS Playwright connectOverCDP through the dt-browser CDP endpoint');
})().catch((e) => { console.error(e); process.exit(1); });
