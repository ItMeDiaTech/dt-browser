import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const sourceOf = (file) => readFileSync(new URL(`../bench/${file}`, import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/^export /gm, '')
  .replaceAll('import.meta.url', JSON.stringify(new URL(`../bench/${file}`, import.meta.url).href))
  .replace(/await import\(/g, 'await importModule(');

test('suite and session benchmarks isolate existing plans and preserve explicit credentials', async () => {
  for (const file of ['suite.js', 'session.js']) {
    const previous = mkdtempSync(join(tmpdir(), 'jev-bench-old-'));
    writeFileSync(join(previous, 'plans.json'), '{"old":{}}');
    const homes = [];
    const env = { JEV_HOME: previous, JEV_SECRETS: '{"www.saucedemo.com":{"username":"demo"}}' };
    const processMock = { env, argv: ['node', new URL(`../bench/${file}`, import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'), 'review', '1'] };
    const result = { status: 'done', evidence: {}, steps: [], jev: { calls: 1, input_tokens: 1 }, elapsed_ms: 0 };
    const tab = { resetOrigin: async () => {}, goto: async () => {}, evaluate: async () => {}, close: async () => {} };
    const runner = { runTask: async () => { homes.push(env.JEV_HOME); return { r: result, ok: true }; },
      Tab: { open: async () => tab }, browse: async () => { homes.push(env.JEV_HOME); return result; }, ok: () => true };
    const parameters = { process: processMock, pathToFileURL, URL, readFileSync, writeFileSync: () => {}, mkdtempSync, tmpdir, join,
      console: { log() {}, error() {} }, secretsFor: () => null, importModule: async () => runner };
    await new AsyncFunction(...Object.keys(parameters), sourceOf(file))(...Object.values(parameters));
    assert.ok(homes.length, file);
    assert.ok(homes.every(home => home !== previous), `${file} reused previous memory`);
    assert.equal(env.JEV_SECRETS, '{"www.saucedemo.com":{"username":"demo"}}');
    assert.equal(readFileSync(join(previous, 'plans.json'), 'utf8'), '{"old":{}}');
  }
});

async function soak({ hours, cleanExit = false, shutdownCode = 0, shutdownSignal = null }) {
  const lines = [];
  let exitCode;
  const output = new EventEmitter(), errors = new EventEmitter(), server = new EventEmitter();
  Object.assign(server, { pid: 123, stdout: output, stderr: errors, kill() {}, stdin: {
    end() { if (cleanExit) server.emit('exit', shutdownCode, shutdownSignal); },
    write(line) {
      const message = JSON.parse(line);
      if (message.method === 'initialize') queueMicrotask(() => output.emit('line', JSON.stringify({ id: message.id, result: {} })));
    },
  } });
  const parameters = { spawn: () => server, appendFileSync: (_path, line) => lines.push(line), mkdtempSync: () => '/isolated',
    tmpdir: () => '/tmp', join: (...parts) => parts.join('/'), createInterface: ({ input }) => input,
    HELDOUT: [{ url: 'http://localhost', goal: 'test' }], SUITE: [], URL,
    process: { argv: ['node', 'soak.js', hours], env: {}, cwd: () => '.', execPath: 'node', exit: code => { exitCode = code; } },
    setTimeout: callback => setTimeout(callback, 0), clearTimeout, console: { error() {} } };
  await new AsyncFunction(...Object.keys(parameters), sourceOf('soak.js'))(...Object.values(parameters));
  await new Promise(resolve => setTimeout(resolve, 15));
  return { lines, exitCode };
}

test('soak exits nonzero for an unanswered call', async () => {
  const result = await soak({ hours: '2' });
  assert.ok(result.lines.some(line => line.includes('stopping: hung call')));
  assert.equal(result.exitCode, 1);
});

test('soak accepts normal child shutdown after its time limit', async () => {
  assert.equal((await soak({ hours: '0', cleanExit: true })).exitCode, 0);
});

test('soak fails on abnormal or missing shutdown after its time limit', async () => {
  for (const shutdown of [{ cleanExit: true, shutdownCode: 42 }, { cleanExit: true, shutdownCode: null, shutdownSignal: 'SIGTERM' }, {}]) {
    assert.equal((await soak({ hours: '0', ...shutdown })).exitCode, 1);
  }
});
