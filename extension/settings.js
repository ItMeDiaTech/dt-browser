// Sidecar Monkey — settings schema, shared by the service worker, popup and options page.
// One place owns defaults and validation, so a bad value in storage can never reach
// the connection or relay code.
// The product name lives only in manifest.json; everything else reads it from there.
const DTB_NAME = chrome.runtime.getManifest().name;
const DTB_DEFAULTS = {
  enabled: true,
  token: '',
  bridgeHost: '127.0.0.1',
  bridgePort: 18765,
  relayEnabled: true,
  relayReuseTabs: false, // reusing a tab navigates it: opt-in only
  relayNewTabs: 'current', // 'current' window (background tab) | 'separate' window
  relayAttachTimeoutMs: 5000,
  logLevel: 'commands', // 'off' | 'commands' | 'all' (adds every CDP call)
};

// The bridge only listens on loopback; anything else would mean sending the token off-machine.
const DTB_HOSTS = ['127.0.0.1', 'localhost']; // the bridge binds IPv4 only
const DTB_PORT_RANGE = [1024, 65535];
const DTB_ATTACH_RANGE = [1000, 30000];

// Returns { values, errors }: values always holds a complete, valid settings object
// (invalid fields fall back to their default); errors maps field -> message.
function dtbValidate(raw) {
  const r = Object.assign({}, DTB_DEFAULTS, raw || {});
  const v = {};
  const errors = {};
  const int = (key, [lo, hi], label) => {
    const n = typeof r[key] === 'string' && r[key].trim() !== '' ? Number(r[key]) : r[key];
    if (Number.isInteger(n) && n >= lo && n <= hi) v[key] = n;
    else { v[key] = DTB_DEFAULTS[key]; errors[key] = `${label} must be a whole number from ${lo} to ${hi}`; }
  };
  const oneOf = (key, allowed, label) => {
    if (allowed.includes(r[key])) v[key] = r[key];
    else { v[key] = DTB_DEFAULTS[key]; errors[key] = `${label} must be one of ${allowed.join(', ')}`; }
  };
  for (const key of ['enabled', 'relayEnabled', 'relayReuseTabs']) v[key] = r[key] !== false;
  v.token = String(r.token == null ? '' : r.token).trim();
  if (/\s/.test(v.token)) { errors.token = 'Token cannot contain spaces'; v.token = DTB_DEFAULTS.token; }
  v.bridgeHost = String(r.bridgeHost || '').trim().toLowerCase();
  if (!DTB_HOSTS.includes(v.bridgeHost)) { errors.bridgeHost = `Host must be ${DTB_HOSTS.join(', ')} (the bridge only listens locally)`; v.bridgeHost = DTB_DEFAULTS.bridgeHost; }
  int('bridgePort', DTB_PORT_RANGE, 'Port');
  int('relayAttachTimeoutMs', DTB_ATTACH_RANGE, 'Attach timeout');
  oneOf('relayNewTabs', ['current', 'separate'], 'New tab placement');
  oneOf('logLevel', ['off', 'commands', 'all'], 'Activity log');
  return { values: v, errors };
}

function dtbBridgeUrl(s) {
  return `ws://${s.bridgeHost}:${s.bridgePort}`;
}

// What the popup and settings page say about the connection.
function dtbStatusView(status, conn, s) {
  const url = (conn && conn.url) || dtbBridgeUrl(s);
  const since = conn && conn.since ? new Date(conn.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  const view = {
    connected: { word: 'Connected', detail: `to ${url}${since ? ` since ${since}` : ''}.` },
    connecting: { word: 'Connecting', detail: `to ${url}.` },
    disconnected: { word: 'Not connected', detail: `Retrying ${url} every few seconds.` },
    disabled: { word: 'Paused', detail: 'Agent control is off.' },
    error: { word: 'Token rejected', detail: `by ${url}. Fix the token, then reconnect.` },
  }[status] || { word: status, detail: '' };
  view.error = conn && conn.error && status !== 'connected' && status !== 'disabled' ? conn.error : null;
  return view;
}

async function dtbLoad() {
  return dtbValidate(await chrome.storage.local.get(Object.keys(DTB_DEFAULTS))).values;
}

const dtbEl = (id) => document.getElementById(id);
const dtbClock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// The status block is identical in the popup and the settings page.
function dtbShowStatus(status, conn, s) {
  const view = dtbStatusView(status, conn, s);
  const box = dtbEl('statusBox');
  box.dataset.status = status;
  box.querySelector('.signal').dataset.status = status;
  dtbEl('stateWord').textContent = view.word;
  dtbEl('stateDetail').textContent = view.detail;
  const err = dtbEl('stateError');
  err.hidden = !view.error;
  err.textContent = view.error || '';
  return view;
}
