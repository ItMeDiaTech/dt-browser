import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadContent(globals) {
  let listener;
  const ctx = vm.createContext({
    location: { href: 'https://example.test/' },
    chrome: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
    ...globals,
  });
  vm.runInContext(readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8'), ctx);
  return (cmd, params) => new Promise((resolve) => listener({ type: 'dtb', cmd, params }, {}, resolve));
}

test('snapshots keep scoped roots, filtered indices and paginated targets consistent', async () => {
  const element = (text, { hidden = false, y = 0 } = {}) => ({
    nodeType: 1, tagName: 'BUTTON', innerText: text, isConnected: true,
    style: { visibility: hidden ? 'hidden' : 'visible', display: 'block', opacity: '1' },
    getBoundingClientRect: () => ({ x: 0, y, width: 20, height: 20, left: 0, right: 20, bottom: y + 20, top: y }),
    getAttribute: (name) => name === 'role' ? 'button' : null,
    hasAttribute: () => false,
  });
  const children = [element('Hidden', { hidden: true }), element('Alpha'), element('Beta', { y: 200 }), element('Gamma')];
  const root = { ...element('Root'), matches: () => true, querySelectorAll: () => children };
  let listener;
  const ctx = vm.createContext({
    window: { innerHeight: 100, innerWidth: 100 },
    document: { body: root, querySelector: () => root, title: 'Fixture', readyState: 'complete' },
    location: { href: 'https://example.test/' },
    getComputedStyle: (el) => el.style,
    HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {}, HTMLDetailsElement: class {},
    chrome: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
  });
  vm.runInContext(readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8'), ctx);
  const call = (cmd, params) => new Promise((resolve) => listener({ type: 'dtb', cmd, params }, {}, resolve));

  const full = await call('snapshot', { selector: '#scope', format: 'full' });
  assert.deepEqual(Array.from(full.elements, (e) => [e.index, e.text]), [[1, 'Root'], [2, 'Alpha'], [3, 'Beta'], [4, 'Gamma']]);
  const page = await call('snapshot', { offset: 1, maxElements: 1 });
  assert.match(page.elements, /^\[2\] button/);
  assert.equal(page.total, 4);
  assert.equal(page.nextOffset, 2);
  assert.equal((await call('get_element_state', { target: 2 })).text, 'Alpha');
  const visible = await call('snapshot', { viewportOnly: true, format: 'full' });
  assert.deepEqual(Array.from(visible.elements, (e) => [e.index, e.text]), [[1, 'Root'], [2, 'Alpha'], [3, 'Gamma']]);
  const filtered = await call('snapshot', { query: 'gamma' });
  assert.match(filtered.elements, /^\[1\] button/);
  assert.equal((await call('get_element_state', { target: 1 })).text, 'Gamma');
  assert.equal((await call('get_element_state', { target: 2 })).ok, false);
});

test('non-clearing typing appends to inputs and textareas regardless of selection', async () => {
  class Input {
    constructor() { this.v = 'before'; this.type = 'text'; this.tagName = 'INPUT'; this.selectionStart = 1; this.selectionEnd = 3; this.events = []; }
    get value() { return this.v; }
    set value(value) { this.v = value; }
    focus() {}
    getAttribute() { return null; }
    dispatchEvent(event) { this.events.push(event.type); }
  }
  class Textarea extends Input { get value() { return this.v; } set value(value) { this.v = value; } }
  let element;
  const call = loadContent({ window: {}, document: { querySelector: () => element }, HTMLInputElement: Input, HTMLTextAreaElement: Textarea,
    InputEvent: class { constructor(type) { this.type = type; } }, Event: class { constructor(type) { this.type = type; } } });
  for (const Kind of [Input, Textarea]) {
    element = new Kind();
    assert.equal((await call('type', { target: '#field', text: 'after', clear: false })).value, 'beforeafter');
    assert.equal(element.value, 'beforeafter');
    assert.deepEqual(element.events, ['input', 'change']);
    assert.equal((await call('type', { target: '#field', text: '', clear: false })).value, 'beforeafter');
    assert.equal((await call('type', { target: '#field', text: 'replacement' })).value, 'replacement');
    assert.equal((await call('type', { target: '#field', text: '' })).value, '');
  }
});

test('an explicit scroll target takes precedence over directional defaults', async () => {
  const targetScrolls = [], windowScrolls = [];
  const target = { scrollIntoView: (options) => targetScrolls.push(options.block) };
  const call = loadContent({ window: { scrollX: 0, scrollY: 0, scrollBy: (options) => windowScrolls.push(options.top) },
    document: { querySelector: (selector) => selector === '#field' ? target : null, querySelectorAll: () => [] } });
  assert.equal((await call('scroll', { target: '#field' })).ok, true);
  assert.equal((await call('scroll', { target: '#field', direction: 'up' })).ok, true);
  assert.deepEqual(targetScrolls, ['center', 'center']);
  assert.deepEqual(windowScrolls, []);
  assert.equal((await call('scroll', { target: '#missing' })).ok, false);
  await call('scroll', {});
  await call('scroll', { direction: 'up', amount: 20 });
  assert.deepEqual(windowScrolls, [600, -20]);
});

test('synchronous selector errors and async failures each produce one structured reply', async () => {
  let listener;
  const ctx = vm.createContext({ window: {}, location: { href: 'https://example.test/' }, document: { title: 'Fixture', querySelector: (selector) => {
    if (selector === '[') throw new Error('invalid selector');
    if (selector === '#throw') return { focus() { throw new Error('focus failed'); } };
    return null;
  } }, chrome: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } } });
  vm.runInContext(readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8'), ctx);
  for (const [cmd, params, message] of [
    ['read', { selector: '#missing' }, /no element matches/],
    ['snapshot', { selector: '[' }, /bad CSS selector/],
    ['type', { target: '#throw' }, /focus failed/],
  ]) {
    const replies = [];
    let response;
    const answered = new Promise((resolve) => { response = resolve; });
    assert.doesNotThrow(() => assert.equal(listener({ type: 'dtb', cmd, params }, {}, (reply) => { replies.push(reply); response(); }), true));
    await answered;
    await Promise.resolve();
    assert.equal(replies.length, 1);
    assert.equal(replies[0].ok, false);
    assert.match(replies[0].error, message);
  }
});

test('Enter submits the form only when the page did not handle the keydown itself', async () => {
  for (const pageHandles of [true, false]) {
    let submits = 0;
    class Input {
      constructor() { this.type = 'text'; this.form = { requestSubmit: () => { submits++; } }; }
      dispatchEvent(event) { return !(pageHandles && event.type === 'keydown'); }
      closest() { return null; }
    }
    const input = new Input();
    const call = loadContent({ window: {}, document: { activeElement: input, body: input },
      HTMLInputElement: Input, KeyboardEvent: class { constructor(type) { this.type = type; } } });
    const reply = await call('press', { key: 'Enter' });
    assert.equal(submits, pageHandles ? 0 : 1);
    assert.equal(reply.action, pageHandles ? 'handled_by_page' : 'form_submit');
  }
});
