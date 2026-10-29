// Validation for the extension's settings schema (extension/settings.js).
// Run: node --test tests/extension_settings.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = { chrome: { runtime: { getManifest: () => ({ name: 'Sidecar Monkey' }) } } };
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL('../extension/settings.js', import.meta.url), 'utf8') + '\nthis.api = { DTB_DEFAULTS, dtbValidate, dtbBridgeUrl, dtbStatusView };', ctx);
const { DTB_DEFAULTS, dtbValidate, dtbBridgeUrl, dtbStatusView } = ctx.api;

test('empty storage yields the defaults with no errors', () => {
  const { values, errors } = dtbValidate({});
  assert.deepEqual({ ...values }, { ...DTB_DEFAULTS });
  assert.deepEqual({ ...errors }, {});
  assert.equal(dtbBridgeUrl(values), 'ws://127.0.0.1:18765');
});

test('valid values pass through, numeric strings are parsed', () => {
  const { values, errors } = dtbValidate({ bridgeHost: 'LOCALHOST', bridgePort: '18800', relayAttachTimeoutMs: 12000, relayNewTabs: 'separate', logLevel: 'all', token: '  abc  ', relayReuseTabs: false });
  assert.deepEqual({ ...errors }, {});
  assert.equal(values.bridgeHost, 'localhost');
  assert.equal(values.bridgePort, 18800);
  assert.equal(values.token, 'abc');
  assert.equal(values.relayReuseTabs, false);
  assert.equal(dtbBridgeUrl(values), 'ws://localhost:18800');
  assert.ok(dtbValidate({ bridgeHost: '[::1]' }).errors.bridgeHost, 'IPv6 loopback: the bridge does not listen there');
});

test('invalid values fall back to defaults and are reported', () => {
  const { values, errors } = dtbValidate({ bridgeHost: 'example.com', bridgePort: 80, relayAttachTimeoutMs: 1.5, relayNewTabs: 'popup', logLevel: 'verbose', token: 'a b' });
  for (const key of ['bridgeHost', 'bridgePort', 'relayAttachTimeoutMs', 'relayNewTabs', 'logLevel', 'token']) {
    assert.ok(errors[key], key);
    assert.equal(values[key], DTB_DEFAULTS[key], key);
  }
  assert.equal(dtbValidate({ bridgePort: '' }).errors.bridgePort !== undefined, true);
});

test('status view surfaces the last error only while not connected', () => {
  const conn = { url: 'ws://127.0.0.1:18765', since: 0, error: 'No bridge is listening at ws://127.0.0.1:18765.' };
  assert.equal(dtbStatusView('disconnected', conn, DTB_DEFAULTS).error, conn.error);
  assert.equal(dtbStatusView('connected', conn, DTB_DEFAULTS).error, null);
  assert.equal(dtbStatusView('error', null, DTB_DEFAULTS).word, 'Token rejected');
});
