import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const patchedPurifier = fileURLToPath(import.meta.resolve('dompurify'));
const monacoBuild = await build({
  entryPoints: {
    'monaco-editor': fileURLToPath(new URL('../bench/site/monaco-editor.js', import.meta.url)),
    'monaco-worker': fileURLToPath(import.meta.resolve('monaco-editor/editor/editor.worker.js')),
  },
  bundle: true, write: false, outdir: 'test-build', format: 'esm', platform: 'browser',
  loader: { '.ttf': 'dataurl' }, metafile: true,
  // Monaco 0.57 vendors an affected purifier; rebuilding replaces it as well as the npm override.
  plugins: [{ name: 'patched-monaco-purifier', setup(builder) {
    builder.onResolve({ filter: /dompurify\/dompurify\.js$/ }, () => ({ path: patchedPurifier }));
  } }],
});
const monacoInputs = Object.keys(monacoBuild.metafile.inputs);
assert.ok(monacoInputs.some((input) => resolve(input) === patchedPurifier));
assert.ok(!monacoInputs.some((input) => input.replaceAll('\\', '/').endsWith('/base/browser/dompurify/dompurify.js')));

const fixtures = new Map([
  ['/workflow.html', readFileSync(new URL('../bench/site/workflow.html', import.meta.url))],
  ['/model-editor.html', readFileSync(new URL('../bench/site/model-editor.html', import.meta.url))],
  ['/monaco-editor.html', readFileSync(new URL('../bench/site/monaco-editor.html', import.meta.url))],
  ...monacoBuild.outputFiles.map((file) => [`/${basename(file.path)}`, file.contents]),
  ...['@codemirror/view', '@codemirror/state', '@marijn/find-cluster-break', 'crelt', 'style-mod', 'w3c-keyname']
    .map((name) => [`/editor-modules/${name}`, readFileSync(new URL(import.meta.resolve(name)))]),
]);
const server = createServer((request, response) => {
  const body = fixtures.get(request.url);
  const type = request.url.endsWith('.css') ? 'text/css' : request.url.startsWith('/editor-modules/') || request.url.endsWith('.js') ? 'text/javascript' : 'text/html';
  response.writeHead(body ? 200 : 404, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  response.end(body ?? 'Not found');
});
const listen = (server) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const relay = process.env.DT_BROWSER_E2E === '1';
let tab, url, profile, cdpPort;
const chromeVersion = () => fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(500) }).then((response) => response.json()).catch(() => null);
before(async () => {
  await listen(server);
  url = `http://127.0.0.1:${server.address().port}/workflow.html`;
  if (relay) {
    const bridge = new URL(process.env.JEV_BRIDGE || 'invalid:');
    assert.equal(bridge.protocol, 'ws:');
    assert.equal(bridge.hostname, '127.0.0.1');
    assert.ok(bridge.port && bridge.port !== '18765', 'requires an isolated bridge port');
    assert.match(process.env.DT_BRIDGE_TOKEN || '', /^[a-f0-9]{64}$/);
  } else {
    // Each test file needs its own browser: other suites send focus-dependent input concurrently.
    const reservation = createServer();
    await listen(reservation);
    process.env.JEV_CDP_PORT = String(cdpPort = reservation.address().port);
    await new Promise((resolve) => reservation.close(resolve));
    delete process.env.JEV_BRIDGE;
    process.env.JEV_PROFILE = profile = resolve(mkdtempSync(join(tmpdir(), 'dt-browser-workflow-')));
    process.env.JEV_HEADLESS = '1';
  }
  const { Tab, bridged } = await import('../src/browser.js');
  assert.equal(bridged, relay);
  tab = await Tab.open();
  if (relay) assert.ok(tab.owned && tab.created, 'workflow must own its relay tab');
});
after(async () => {
  try {
    if (relay) await tab?.close();
    if (profile) {
      // Browser-level CDP still works when Tab.open failed partway through page setup.
      const browser = await chromeVersion();
      if (browser) {
        assert.equal(new URL(browser.webSocketDebuggerUrl).host, `127.0.0.1:${cdpPort}`);
        await new Promise((resolve, reject) => {
          const socket = new WebSocket(browser.webSocketDebuggerUrl);
          const finish = (error) => { clearTimeout(timer); socket.close(); error ? reject(error) : resolve(); };
          const timer = setTimeout(() => finish(new Error('isolated Chrome did not close')), 3000);
          socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
          socket.onmessage = socket.onclose = () => finish();
          socket.onerror = () => finish(new Error('could not close isolated Chrome'));
        });
      }
      for (let attempt = 0; attempt < 30 && await chromeVersion(); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(await chromeVersion(), null, 'isolated Chrome must stop before its profile is removed');
      assert.equal(dirname(profile), resolve(tmpdir()));
      assert.ok(basename(profile).startsWith('dt-browser-workflow-'));
      // Windows Chrome children may release profile handles after its CDP endpoint closes.
      await rm(profile, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    }
  } finally {
    tab?.cdp.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
const pick = async (label) => {
  const matches = (await tab.observe()).elements.filter((element) => element.label === label || element.label.startsWith(`${label} — `));
  assert.equal(matches.length, 1, `expected exactly one ${label}`);
  return matches[0];
};
const click = async (label) => { await tab.click((await pick(label)).i); await tab.settle(); };
const fresh = async () => { await tab.resetOrigin(url); await tab.goto(url); };
const read = () => tab.evaluate(`({workspace: document.querySelector('#workspaceTrigger').textContent,
  plain: document.querySelector('#plain').value, editor: document.querySelector('#editor').innerText,
  decoy: document.querySelector('#decoy').value, status: document.querySelector('#status').textContent,
  stored: JSON.parse(localStorage.getItem('dt-browser-workflow'))})`);
const savedRevision = (revision) => tab.evaluate(`new Promise((resolve, reject) => {
  const until = Date.now() + 3000;
  const check = () => document.querySelector('#status').textContent === 'Saved revision ${revision}' ? resolve() : Date.now() > until ? reject(new Error('save did not complete')) : setTimeout(check, 20);
  check(); })`);
const replacement = ['  Unicode document: café e\u0301 中文 العربية 👩🏽‍💻', '',
  ...Array.from({ length: 90 }, (_, index) => `\tLine ${index}: "quoted" <markup> & Ω — keep  two spaces 🦊`), 'Final line'].join('\n');

test('portal options distinguish similar labels and scroll an offscreen choice into view', async () => {
  await fresh();
  await click('Red team');
  assert.equal(await tab.evaluate("document.querySelector('#workspaceOptions').parentElement === document.body && document.querySelector('#workspaceTrigger').getAttribute('aria-controls') === 'workspaceOptions'"), true);
  await click('Blue team (archived)');
  assert.equal((await read()).workspace, 'Blue team (archived)');
  await click('Blue team (archived)');
  await click('Blue team');
  assert.equal((await read()).workspace, 'Blue team');
  await click('Blue team');
  assert.equal((await pick('Green team')).offscreen, true);
  await click('Green team');
  assert.equal((await read()).workspace, 'Green team');
  assert.equal(await tab.evaluate("document.querySelector('#workspaceTrigger').ariaExpanded"), 'false');
});

test('textarea and contenteditable replace large Unicode documents after focus moves to a decoy', async () => {
  await fresh();
  for (const [label, property] of [['Plain text', 'plain'], ['Source editor', 'editor']]) {
    await tab.type((await pick(label)).i, 'Obsolete content must disappear');
    const target = await pick(label);
    await click('Decoy field');
    assert.equal(await tab.evaluate('document.activeElement.id'), 'decoy');
    await tab.type(target.i, replacement);
    await click('Decoy field');
    assert.equal((await read())[property], replacement, property);
    assert.equal((await read()).decoy, 'Leave this unchanged');
  }
});

test('preview is inert; asynchronous saves persist exact values and revisions across reload', async () => {
  await fresh();
  await click('Red team'); await click('Blue team');
  await tab.type((await pick('Plain text')).i, replacement);
  await tab.type((await pick('Source editor')).i, replacement);
  await click('Preview save');
  assert.equal((await read()).status, 'Preview only — changes not persisted');
  assert.equal((await read()).stored, null);
  await tab.goto(url);
  assert.equal((await read()).plain, 'Original plain text');
  assert.equal((await read()).status, 'Not saved');
  await click('Red team'); await click('Blue team');
  await tab.type((await pick('Plain text')).i, replacement);
  await tab.type((await pick('Source editor')).i, replacement);
  await click('Save document');
  await savedRevision(1);
  const saved = { workspace: 'Blue team', plain: replacement, editor: replacement, revision: 1 };
  assert.deepEqual((await read()).stored, saved);
  await tab.goto(url);
  assert.deepEqual(await read(), { workspace: saved.workspace, plain: replacement, editor: replacement, decoy: 'Leave this unchanged', status: 'Saved revision 1', stored: saved });
  await tab.type((await pick('Plain text')).i, 'Updated after reload');
  await click('Preview save');
  assert.deepEqual((await read()).stored, saved);
  await click('Save document'); await savedRevision(2);
  await tab.goto(url);
  assert.deepEqual((await read()).stored, { ...saved, plain: 'Updated after reload', revision: 2 });
  assert.equal((await read()).status, 'Saved revision 2');
});

test('CodeMirror keyboard edits round-trip its actual document model through save and reload', async () => {
  const editorUrl = new URL('/model-editor.html', url).href;
  const documentText = Array.from({ length: 5 }, (_, index) => `Section ${index}\n${replacement}`).join('\n\n');
  const model = () => tab.evaluate(`({text: modelEditor.state.doc.toString(), stored: JSON.parse(localStorage.getItem('dt-browser-model-editor')),
    decoy: document.querySelector('#decoy').value, virtual: modelEditor.viewport.from > 0 || modelEditor.viewport.to < modelEditor.state.doc.length})`);
  await tab.resetOrigin(editorUrl); await tab.goto(editorUrl);
  assert.equal((await model()).text, '');
  await click('Model editor'); await tab.insert('First draft: café 中文 🦊');
  assert.equal((await model()).text, 'First draft: café 中文 🦊');
  await click('Decoy field');
  assert.equal(await tab.evaluate('document.activeElement.id'), 'decoy');
  await click('Model editor'); await tab.key('Control+a'); await tab.insert(documentText); await tab.settle();
  const edited = await model();
  assert.equal(edited.text, documentText);
  assert.equal(edited.decoy, 'Leave this unchanged');
  assert.equal(edited.stored, null);
  assert.equal(edited.virtual, true, 'the model must include text outside the rendered viewport');
  await click('Save model document'); await savedRevision(1);
  assert.deepEqual((await model()).stored, { text: documentText, revision: 1 });
  await tab.goto(editorUrl);
  assert.equal((await model()).text, documentText);
  assert.deepEqual((await model()).stored, { text: documentText, revision: 1 });
  await click('Model editor'); await tab.key('Control+a'); await tab.insert('Replaced after reload: Ω\n\n👩🏽‍💻');
  await click('Save model document'); await savedRevision(2); await tab.goto(editorUrl);
  assert.equal((await model()).text, 'Replaced after reload: Ω\n\n👩🏽‍💻');
  assert.deepEqual((await model()).stored, { text: 'Replaced after reload: Ω\n\n👩🏽‍💻', revision: 2 });
});

test('zero-width EditContext targets use visible parent geometry at the viewport edge', async () => {
  await fresh();
  await tab.evaluate(`(() => {
    const surface = document.createElement('div'); surface.id = 'edgeSurface';
    surface.style.cssText = 'position:fixed;left:0;top:0;width:120px;height:30px;z-index:10';
    const input = document.createElement('div'); input.setAttribute('role', 'textbox');
    input.setAttribute('aria-label', 'Edge editor'); input.tabIndex = 0;
    input.style.cssText = 'width:0;height:20px'; input.editContext = new EditContext();
    surface.append(input); document.body.append(surface);
    const host = document.createElement('div'); host.id = 'shadowSurface';
    const shadowInput = input.cloneNode(); shadowInput.setAttribute('aria-label', 'Shadow editor');
    shadowInput.editContext = new EditContext(); host.attachShadow({ mode: 'open' }).append(shadowInput);
    document.body.append(host);
  })()`);
  assert.equal(await tab.evaluate("document.querySelector('#edgeSurface [role=textbox]').getBoundingClientRect().left"), 0);
  assert.equal((await tab.observe()).elements.some((element) => element.label === 'Shadow editor'), false);
  const target = await pick('Edge editor');
  assert.deepEqual(await tab.locate(target.i), { x: 60, y: 15, covered: false, editContext: true });
  for (const style of ['visibility:hidden', 'opacity:0', 'display:none', 'left:-120px']) {
    await tab.evaluate(`document.querySelector('#edgeSurface').style.cssText = 'position:fixed;left:0;top:0;width:120px;height:30px;${style}'`);
    assert.equal((await tab.observe()).elements.some((element) => element.label === 'Edge editor'), false, style);
  }
  await tab.evaluate("document.querySelector('#edgeSurface').remove(); document.querySelector('#shadowSurface').remove()");
});

test('Monaco keyboard edits round-trip the complete text model through save and reload', async () => {
  const editorUrl = new URL('/monaco-editor.html', url).href;
  const documentText = Array.from({ length: 5 }, (_, index) => `Section ${index}\n${replacement}`).join('\n\n');
  const model = () => tab.evaluate(`({text: monacoEditor.getModel().getValue(), stored: JSON.parse(localStorage.getItem('dt-browser-monaco-editor')),
    decoy: document.querySelector('#decoy').value, virtual: monacoEditor.getVisibleRanges().some((range) => range.startLineNumber > 1 || range.endLineNumber < monacoEditor.getModel().getLineCount())})`);
  const focusEditor = async () => {
    await click('Decoy field');
    assert.equal(await tab.evaluate('document.activeElement.id'), 'decoy');
    await click('Monaco text input');
    assert.equal(await tab.evaluate("document.querySelector('#monacoHost').contains(document.activeElement)"), true);
  };
  await tab.resetOrigin(editorUrl); await tab.goto(editorUrl);
  assert.equal((await model()).text, '');
  assert.equal(await tab.evaluate("document.querySelector('[aria-label=\"Monaco text input\"]').getBoundingClientRect().width"), 0);
  await focusEditor(); await tab.insert('First draft: café 中文 🦊');
  assert.equal((await model()).text, 'First draft: café 中文 🦊');
  await focusEditor(); await tab.key('Control+a'); await tab.insert(documentText); await tab.settle();
  const edited = await model();
  assert.equal(edited.text, documentText);
  assert.equal(edited.decoy, 'Leave this unchanged');
  assert.equal(edited.stored, null);
  assert.equal(edited.virtual, true, 'Monaco must preserve lines outside its rendered viewport');
  await click('Save Monaco document'); await savedRevision(1);
  assert.deepEqual((await model()).stored, { text: documentText, revision: 1 });
  await tab.goto(editorUrl);
  assert.equal((await model()).text, documentText);
  assert.deepEqual((await model()).stored, { text: documentText, revision: 1 });
  await focusEditor(); await tab.key('Control+a'); await tab.insert('Replaced after reload: Ω\n\n👩🏽‍💻');
  await click('Save Monaco document'); await savedRevision(2); await tab.goto(editorUrl);
  assert.equal((await model()).text, 'Replaced after reload: Ω\n\n👩🏽‍💻');
  assert.deepEqual((await model()).stored, { text: 'Replaced after reload: Ω\n\n👩🏽‍💻', revision: 2 });
});
