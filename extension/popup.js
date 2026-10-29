// Sidecar Monkey — popup: connection at a glance, the master switch, and a token fix when auth fails.
async function render() {
  const s = await dtbLoad();
  const { status } = await chrome.storage.local.get({ status: 'disconnected' });
  const { conn, activity } = await chrome.storage.session.get({ conn: null, activity: [] });
  dtbShowStatus(status, conn, s);

  dtbEl('allow').checked = s.enabled;
  dtbEl('allowHint').textContent = s.enabled
    ? 'Agents connected to the bridge can drive tabs in this browser.'
    : 'Agents cannot drive this browser until you turn this on.';
  dtbEl('tokenForm').hidden = status !== 'error'; // a --no-auth bridge accepts an empty token

  const recent = activity.slice(-5).reverse();
  dtbEl('activity').replaceChildren(...recent.map((a) => {
    const li = document.createElement('li');
    if (!a.ok) { li.className = 'failed'; li.title = a.error || ''; }
    const cmd = document.createElement('span');
    cmd.className = 'cmd';
    cmd.textContent = a.method ? `${a.cmd} ${a.method}` : a.cmd;
    const ms = document.createElement('span');
    ms.className = 'muted';
    ms.textContent = a.ok ? `${a.ms} ms` : 'failed';
    const at = document.createElement('span');
    at.className = 'muted';
    at.textContent = dtbClock(a.t);
    li.append(cmd, ms, at);
    return li;
  }));
  dtbEl('activityEmpty').hidden = recent.length > 0;
  dtbEl('activityEmpty').textContent = s.logLevel === 'off'
    ? 'Activity logging is off. Turn it on in Settings.'
    : 'No commands yet. They appear here as agents use the browser.';
}

dtbEl('name').textContent = DTB_NAME;
dtbEl('version').textContent = 'v' + chrome.runtime.getManifest().version;
document.title = DTB_NAME;

dtbEl('allow').addEventListener('change', () => chrome.runtime.sendMessage({ type: 'dtb_set', enabled: dtbEl('allow').checked }));

dtbEl('tokenForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await chrome.runtime.sendMessage({ type: 'dtb_set', token: dtbEl('token').value });
  dtbEl('tokenError').hidden = r.ok;
  dtbEl('tokenError').textContent = r.ok ? '' : r.errors ? r.errors.token : r.error;
  if (r.ok) dtbEl('token').value = '';
});

dtbEl('reconnect').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'dtb_action', action: 'reconnect' }));
dtbEl('openSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener(() => { render(); });
render();
