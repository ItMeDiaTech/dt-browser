// Sidecar Monkey — settings page. Every control saves on change through the service worker,
// which validates it (settings.js) before it reaches storage.

let savedTimer = null;
function flashSaved(text) {
  dtbEl('saved').textContent = text;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { dtbEl('saved').textContent = ''; }, 2000);
}

function showErrors(errors) {
  for (const el of document.querySelectorAll('[data-error]')) {
    const msg = errors[el.dataset.error];
    if (msg === undefined) continue;
    el.hidden = !msg;
    el.textContent = msg || '';
  }
}

// Field ids by setting, for marking invalid input.
const FIELD = { bridgeHost: 'bridgeHost', bridgePort: 'bridgePort', token: 'token', relayAttachTimeoutMs: 'attachTimeout' };

// The page shows the attach timeout in seconds; the stored value and validator use ms.
const MESSAGE = { relayAttachTimeoutMs: 'Attach timeout must be from 1 to 30 seconds' };

// Set while the token field holds an edit that hasn't been saved, so render() leaves it alone.
let tokenDirty = false;

async function save(updates) {
  const r = await chrome.runtime.sendMessage({ type: 'dtb_set', ...updates });
  const errors = Object.fromEntries(Object.keys(updates).map((key) => [key, r.errors && r.errors[key] ? MESSAGE[key] || r.errors[key] : '']));
  showErrors(errors);
  for (const [key, msg] of Object.entries(errors)) if (FIELD[key]) dtbEl(FIELD[key]).setAttribute('aria-invalid', msg ? 'true' : 'false');
  if (r.ok) {
    if ('token' in updates) tokenDirty = false;
    flashSaved('Saved');
    render(); // storage fires no change event when the saved values equal the stored ones
  }
  else if (r.error) flashSaved(r.error);
  return r.ok;
}

async function render() {
  const s = await dtbLoad();
  const { status } = await chrome.storage.local.get({ status: 'disconnected' });
  const { conn, activity } = await chrome.storage.session.get({ conn: null, activity: [] });

  dtbShowStatus(status, conn, s);

  // Don't overwrite a field the user is typing in or one holding a rejected value.
  for (const el of document.querySelectorAll('[data-key]')) {
    if (el === document.activeElement || el.getAttribute('aria-invalid') === 'true') continue;
    const value = s[el.dataset.key];
    if (el.type === 'checkbox') el.checked = value;
    else if (el.type === 'radio') el.checked = el.value === value;
    else el.value = value;
  }
  const timeout = dtbEl('attachTimeout');
  if (timeout !== document.activeElement && timeout.getAttribute('aria-invalid') !== 'true') timeout.value = s.relayAttachTimeoutMs / 1000;
  if (!tokenDirty && dtbEl('token').getAttribute('aria-invalid') !== 'true') dtbEl('token').value = s.token;
  dtbEl('tokenState').textContent = s.token
    ? 'A token is saved. It must match bridge\\token.txt (or DT_BRIDGE_TOKEN) on this machine.'
    : 'No token saved. Paste the one from bridge\\token.txt unless the bridge runs with --no-auth.';

  const rows = activity.slice().reverse();
  dtbEl('activity').replaceChildren(...rows.map((a) => {
    const tr = document.createElement('tr');
    const cells = [dtbClock(a.t), a.method ? `${a.cmd} ${a.method}` : a.cmd, a.tabId ?? '', `${a.ms} ms`, a.ok ? 'OK' : a.error || 'Failed'];
    cells.forEach((text, i) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (i === 3) td.className = 'num';
      if (i === 4 && !a.ok) td.className = 'failed';
      tr.append(td);
    });
    return tr;
  }));
  dtbEl('activityEmpty').hidden = rows.length > 0;
  dtbEl('activityEmpty').textContent = s.logLevel === 'off'
    ? 'Recording is off. Choose what to record above.'
    : 'No commands yet. They appear here as agents use the browser.';
}

const name = DTB_NAME;
dtbEl('name').textContent = `${name} settings`;
document.title = `${name} settings`;
dtbEl('version').textContent = `${name} v${chrome.runtime.getManifest().version}`;

for (const el of document.querySelectorAll('[data-key]')) {
  el.addEventListener('change', () => {
    if (el.type === 'radio' && !el.checked) return;
    save({ [el.dataset.key]: el.type === 'checkbox' ? el.checked : el.value });
  });
}

dtbEl('attachTimeout').addEventListener('change', () => {
  const sec = Number(dtbEl('attachTimeout').value);
  // A blank or non-numeric entry goes through as-is so the validator names the problem.
  save({ relayAttachTimeoutMs: dtbEl('attachTimeout').value.trim() && Number.isFinite(sec) ? Math.round(sec * 1000) : dtbEl('attachTimeout').value });
});

dtbEl('token').addEventListener('input', () => { tokenDirty = true; });
dtbEl('saveToken').addEventListener('click', () => save({ token: dtbEl('token').value }));
dtbEl('token').addEventListener('keydown', (e) => { if (e.key === 'Enter') save({ token: dtbEl('token').value }); });
dtbEl('showToken').addEventListener('click', () => {
  const show = dtbEl('token').type === 'password';
  dtbEl('token').type = show ? 'text' : 'password';
  dtbEl('showToken').textContent = show ? 'Hide' : 'Show';
  dtbEl('showToken').setAttribute('aria-pressed', String(show));
});

dtbEl('reconnect').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'dtb_action', action: 'reconnect' }));
dtbEl('clearLog').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'dtb_action', action: 'clear_activity' });
  flashSaved('Log cleared');
});
dtbEl('resetDefaults').addEventListener('click', async () => {
  if (!confirm('Reset every setting except the bridge token to its default?')) return;
  const { token, ...defaults } = DTB_DEFAULTS;
  for (const el of document.querySelectorAll('[aria-invalid="true"]')) el.setAttribute('aria-invalid', 'false');
  if (await save(defaults)) flashSaved('Defaults restored');
});

chrome.storage.onChanged.addListener(() => { render(); });
render();
