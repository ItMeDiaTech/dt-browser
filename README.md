# dt-browser — Sidecar Monkey

A Chrome extension + local bridge that lets **Hermes Agent (CLI and Desktop)** drive
your **real Chrome browser** — the live session with your logins, cookies and tabs —
as opposed to a separate automated browser. Hermes calls MCP tools; the bridge relays
them over WebSocket to the extension, which operates tabs and the DOM directly.

```
Hermes Agent (CLI / Desktop)
   │  MCP (streamable HTTP)  http://127.0.0.1:18899/mcp
   ▼
bridge.py  ── WebSocket ws://127.0.0.1:18765 ──►  Chrome extension (MV3)
   │                                                │ chrome.tabs / scripting / content script
   └─ logs: bridge/bridge.log                       ▼
                                              your real Chrome
```

## What Hermes can do

The MCP surface exposes four high-value tools so every model turn does not carry
repetitive schemas:

- `browser_health` — connection, tab count and active-tab context; full tabs are opt-in.
- `browser_read` — bounded page text plus compact actionable element indices. It supports
  `page`, `text`, `snapshot`, `screenshot` (direct disk save + path return for AI vision),
  `elements` (structured JSON), and `html` modes, accessible-name queries, CSS scoping,
  pagination, viewport filtering and optional geometry.
- `browser_do` — one validated dispatcher for tab operations (create, remove, name, switch),
  navigation, click (including double click), hover, select option, typing, keys (with combos
  like Ctrl+Enter), inner/window scrolling, element state inspection, polling/looping
  (`loop_check`), HTML export, waits, screenshots, main-world eval and bounded file uploads.
- `browser_help` — returns command parameters only when requested.

`browser_do` commands: `list_tabs`, `open_tab`, `close_tab`, `create_tab`, `remove_tab`,
`name_tab`, `list_named_tabs`, `switch_tab`, `activate_tab`, `navigate`, `get_state`,
`get_element_state`, `snapshot`, `click`, `hover`, `select_option`, `type`, `press`, `scroll`,
`extract_text`, `export_html`, `loop_check`, `screenshot`, `eval`, `upload_files`, `wait_for`,
`back`, `forward`, and `reload`. Parameters use snake_case. Every command returns tab
identification (`tab_id`, `tab_name`, `tab_title`, `tab_url`) so multi-tab workflows are
transparent.

Tool names in Hermes are prefixed, for example `mcp__dt_browser__browser_read`.

## Install

### 1. Load the extension into your real Chrome (one-time, 30 seconds)

In the Chrome profile you use (paths below: `<repo>` = your dt-browser checkout):

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select `<repo>\extension`
4. Pin the "Sidecar Monkey" icon (puzzle icon → pin)

Note: stable Chrome 137+ removed the `--load-extension` flag, so this manual step
is required once. The extension connects on its own afterwards (service worker +
30s keepalive alarm; it survives restarts and reconnects when the bridge restarts).

### 2. Start the bridge

```
<repo>\bridge\start_bridge.cmd
```

or manually:

```
cd <repo>\bridge
uv run python bridge.py --show-token   # explicit pairing output
```

The token is **required**; `--no-auth` (isolated development only) also needs
`DT_BRIDGE_ALLOW_NO_AUTH=1`. It comes from `DT_BRIDGE_TOKEN` or `bridge\token.txt`, never the
command line (other processes can read a command line), and it never crosses a socket: the
bridge and each WebSocket client prove they hold it with HMAC-SHA256 over each other's nonces,
and MCP HTTP callers send it as `Authorization: Bearer <token>`. `DT_BRIDGE_EXTENSION_ID` (the id on
chrome://extensions) optionally pins the one extension allowed to connect.
`bridge\token.txt` is a gitignored standing credential. If absent, the bridge creates
a 256-bit token there; normal daemon starts (including `start_bridge.cmd`) never
print it. Use the explicit `--show-token` flag for pairing, then save it in the extension
popup once; reconnects reuse `chrome.storage.local`.

Autostart at login (Task Scheduler):

```
<repo>\scripts\install_autostart.cmd
```

Lifecycle: the bridge exits on its own ~30s after the last Hermes desktop/CLI
instance closes (the always-on gateway does not count). A connected jev-harness keeps it up,
attached to a tab or not. `--no-lifecycle` disables the self-exit; the logon autostart task
uses it. If the MCP port cannot be bound, the bridge exits with an error instead of running
WebSocket-only.

### jev-harness on your real Chrome

The extension also relays raw Chrome DevTools Protocol (`chrome.debugger`) to
authenticated relay clients, so [jev-harness](jev-harness/README.md) can run in
your own Chrome profile instead of its dedicated one. A `relay` client may only use
`ping`, `list_tabs` and `cdp_open {url?}` (a tab a relay opened before on that site; with
"Use my open tabs" on, also your own background tab there, never the active one; else a new
background tab in the current window), `cdp_attach`, `cdp_send`, `cdp_detach`, `cdp_close`.
`relay_cmd.py` connects as `hermes-cli`, which keeps the full command set. CDP events stream
back to the relay that opened the tab, and only that relay can drive it; `cdp_close` closes
only tabs a relay opened (your own are detached). A relay that disconnects has its
tabs detached. Chrome shows its "is debugging this browser" banner on attached
tabs, only for the length of each jev-harness call; pressing Cancel there detaches
jev-harness. To drop the banner entirely, run `scripts/silent-debugger-banner.ps1` once: it adds
Chrome's `--silent-debugger-extension-api` switch to every launcher that can become the browser
process (taskbar/start-menu/desktop shortcuts and the logon auto-launch Run value — a later
`chrome.exe` joins the running instance and its flags are ignored), then restart Chrome. The switch
hides the banner for **every** extension holding the debugger permission, not only this one.

After updating, reload the extension in `chrome://extensions` and accept the new
"debugger" permission (Chrome 125+). The extension, the bridge, jev-harness and `relay_cmd.py`
speak handshake version 2 together: after pulling, restart the bridge and reload the extension.

Watch the bridge live:

```
Get-Content "<repo>\bridge\bridge.log" -Wait -Tail 20
```

### Playwright on your real Chrome

The bridge also serves a Chrome DevTools endpoint at `http://127.0.0.1:18922` (`--cdp-port` /
`DT_BRIDGE_CDP_PORT`, `0` turns it off). Playwright's `connectOverCDP` then drives your signed-in
Chrome through the same relay jev-harness uses: each connection is one relay client, with the same
tab rules. It sees only the tabs it opens (`context.newPage()`), popups those tabs open, and
your own tabs that you name with `?tab=<id>`. Ids come from `/json/list`. `page.close()`
closes a tab the relay opened and only detaches one of yours. Disconnecting detaches everything.
The endpoint needs `Authorization: Bearer <bridge token>` and refuses requests with an `Origin`
header.

```js
const { chromium } = require('playwright');
const browser = await chromium.connectOverCDP('http://127.0.0.1:18922',
  { headers: { Authorization: `Bearer ${process.env.DT_BRIDGE_TOKEN}` } });
const page = await browser.contexts()[0].newPage();   // one context: your Chrome profile
await page.goto('https://example.com');
await browser.close();                                 // disconnects; your Chrome stays open
```

Playwright MCP (`@playwright/mcp`) connects the same way:

```
claude mcp add playwright-real -- npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:18922 --cdp-header "Authorization: Bearer <token>"
```

There is one browser context: `browser.newContext()` is not available, and
`Browser.getVersion` reports `Chrome/dt-browser`. Pipelined commands reach Chrome in the order
they were sent: a mouse press always arrives before its release. Popups come from the
`webNavigation` permission, because Chrome's `openerTabId` names the window's active tab when a
link is clicked in a background tab. After updating, reload the extension and accept the new
permission. Your Chrome blocks `window.open` without a user gesture, as it would for you, so
open popups by clicking. The settings switch is now called **DevTools relay** and gates
Playwright as well as jev-harness.

### 3. MCP client registration

Any MCP client that speaks streamable HTTP can use the bridge; no TypeSafe key is needed.

```
claude mcp add --transport http dt-browser http://127.0.0.1:18899/mcp --header "Authorization: Bearer <token>"
hermes mcp add dt-browser --url http://127.0.0.1:18899/mcp --auth header   # header: Authorization: Bearer <token>
hermes mcp list    # → dt-browser  http://127.0.0.1:18899/mcp  ✓ enabled
```

The tools appear in **CLI sessions and the Desktop app** (same config). In Desktop,
make sure the tools are enabled for the chat (tools toggle). Restart Hermes after
registration.

## Usage examples (just ask Hermes)

- "Using the browser tools, open https://news.ycombinator.com and summarize the top 3 stories."
- "Navigate to Gmail and tell me how many unread emails there are."
- "On the current tab, click the button labeled 'Sign in' and type my username into the email field."
- "Take a screenshot of the current page and save it."

Recommended agent flow: call `browser_read` first, then pass its numbered index to
`browser_do` with `click` or `type`. Use `query` to return only relevant controls;
re-read after navigation or major DOM changes because indices are document-local.

`browser_do(command="type", params={..., "clear": false})` appends to input and
textarea values; the default replaces them. A scroll target takes precedence over
direction. Numeric tab IDs must match exactly; a missing ID returns an error.
`close_tab`/`remove_tab` need a `tab_id` or a known `name` and never default to the
active tab. `export_html` `save_path` must be a file name inside the export folder.

`browser_do(command="screenshot")` saves a PNG under the system temporary directory
and returns its path instead of injecting base64 into model context. Set
`include_data_url=true` only when the bytes are genuinely needed inline.

## Token efficiency

Measured on the retained isolated E2E artifact with 126 controls and 67,369 visible characters:

- Per-turn tool schemas (recorded when the direct-tool surface existed): **2,269 → 567 tokens** (-75.01%).
- Full control inspection: **5,909 → 1,653 tokens** (-72.03%).
- Accessible-name control lookup: **5,909 → 98 tokens** (-98.34%).
- Text plus controls: **26,487 → 2,613 tokens** (-90.13%).
- Screenshot result: **140,736 → 75 tokens** (-99.95%).

Counts use canonical compact JSON and `tiktoken 0.14.0` `o200k_base`; provider
framing and model prose are excluded. Reproduce the task rows after the isolated E2E
writes its artifacts:

```
cd <repo>\bridge
uv run --with tiktoken==0.14.0 python ..\scripts\token_benchmark.py
```

## Security

- Bridge binds **127.0.0.1 only** (WS, MCP and the CDP endpoint); nothing is exposed to the LAN/internet.
- Token auth, both ways: every WebSocket client answers the bridge's nonce with
  HMAC(token), and the bridge answers the client's, so the token never crosses the socket.
  The extension runs no command until the bridge has proved itself: a process squatting on
  the port while the bridge is down gets neither the token nor control. Without a matching
  token the bridge closes the connection (see popup → red status).
- Browser-origin WebSockets are restricted to Chrome-extension origins; native relay
  clients must omit Origin. HTTP(S) page origins are rejected even under `--no-auth`.
- The MCP endpoint needs `Authorization: Bearer <token>` and refuses any request
  carrying an `Origin` header (no web page can call it) or a non-loopback `Host`.
- **Agent control** switch (popup and settings): off = extension refuses
  all commands, closes the socket, and suppresses reconnects until re-enabled.
- **DevTools relay** switch (settings): off = every `cdp_*` command is refused and
  tabs already attached are detached; the DOM tools keep working.
- `browser_eval` runs JS in the page's main world — powerful by design, and it is
  the intended way to read page internals; only token holders can call it.
- Screenshot `save_path` is a file name inside the bridge's screenshot folder
  (`%LOCALAPPDATA%\Temp\dt-browser-screenshots`); any other path is refused.
- The extension stores no website credentials. Its bridge token lives in
  `chrome.storage.local`, restricted to the extension's own pages (content scripts cannot
  read it), and settings change only from the popup or settings page.

## Settings

The popup shows the connection, the Agent control switch, the last few commands and,
when the token is missing or rejected, a field to paste it. **Settings** (popup link, or
right-click the icon → Options) holds the rest; every change saves immediately, is
validated, and lives in `chrome.storage.local`, so it survives an extension reload:

| Setting | Default | Effect |
|---|---|---|
| Bridge address | `127.0.0.1` : `18765` | WebSocket the extension connects to. Loopback hosts only; match the bridge's `--ws-port` |
| Bridge token | empty | Must equal `bridge\token.txt` / `DT_BRIDGE_TOKEN`. Show/hide and save in place |
| Agent control | on | Master switch (see Security) |
| DevTools relay | on | Allows the raw CDP relay (`cdp_*`) for jev-harness and the Playwright CDP endpoint |
| Use my open tabs | off | `cdp_open` may attach to (and the client then navigates) your own background tab already on the site, never the active one; off = only tabs a relay opened |
| Open new tabs in | current window | Background tab in the focused window, or one separate relay window reused while open |
| Attach timeout | 5 s (1–30) | How long `chrome.debugger.attach` may take before the next candidate tab is tried |
| Activity log | commands | `commands`, `all` (adds every `cdp_send` method) or off. Last 200 entries, cleared when Chrome exits |

The settings page also shows when the current connection began and why the last attempt
failed, with a Reconnect button. Reset to defaults keeps the token.

## Limitations

- `chrome://` pages, the Chrome Web Store, PDF viewer and unloaded tabs cannot be
  driven (Chrome blocks extensions there) — the tools return an explicit error.
- Pages with a strict CSP that bans inline scripts/unsafe-eval reject `browser_eval`;
  the DOM tools (click/type/snapshot) still work there.
- Screenshots of a **background** tab are captured over CDP (`Page.captureScreenshot`) and never
  front it; a screenshot of the active tab still uses `captureVisibleTab`, with bounded retries
  that may briefly focus the window after a capture failure and respect Chrome's one-second quota.
  A tab that has never painted can refuse the CDP capture; that is reported as an error rather
  than answered by fronting the tab.
- `open_tab`/`create_tab` open in the background by default (`active: false`), so a
  script can never steal the operator's focus; pass `activate: true` when a human is
  meant to look at the new tab. `switch_tab`/`activate_tab` stay explicit.
- `browser_eval` on strict-CSP pages (no `unsafe-eval`): the injected main-world
  function is refused — the DOM tools still work there.
- Synthetic key events don't trigger native defaults — Enter submits the focused
  form and Tab moves focus explicitly; Enter in a textarea does not insert a
  newline and Shift+Tab is not supported (use `browser_type` with `\n` for
  textareas).
- Rich-text editing uses the deprecated-but-universal `document.execCommand('insertText')`
  (no drop-in replacement exists).
- Screenshots/snapshots work per-window; if the window is minimized it is restored first.

## Passwords & autofill

Because Hermes drives your **real** Chrome profile, everything your browser knows
is in play: saved passwords autofill on login pages, session cookies persist,
2FA stays logged in, etc. Caveats:

- **Autofill works, "Save password?" prompts may not fire** for credentials Hermes
  types with `browser_type` — Chrome's save-prompt heuristic keys off trusted
  (human) input, and extension-generated events are untrusted by design. If a
  login works but Chrome doesn't offer to save it, log in manually once with the
  same credentials and Chrome saves them as usual.
- Routine `browser_read`/snapshot/type results redact password fields and sensitive
  autocomplete classes (OTP and payment fields). Explicit authorized `browser_eval`
  can still read page DOM values by design.
- Hermes cannot *read* your password vault (Chrome gives extensions no access to
  it). If Hermes needs a password, put it in a local file (e.g. `~/hermes-secrets.env`)
  and have it read from there — never in the chat history.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Popup shows "bridge not reachable" | Start the bridge (step 2); check `bridge.log` |
| Windows error 10013 binding a port | Check `netsh interface ipv4 show excludedportrange protocol=tcp`. Defaults are 18765/18899 because Windows reserved the former 8765/8899 ports. Keep bridge, extension, clients and watchdog ports aligned. |
| Popup shows "Token rejected" | Run `uv run python bridge.py --show-token` in `bridge\` and paste that token into the popup |
| Popup says the server "could not prove it holds the bridge token" | Something other than the bridge (or an older bridge) answered on the port. Stop it, start the bridge, then Reconnect |
| `browser_health` → `extension_connected: false` | Extension not loaded / toggle off / Chrome restarted without the bridge running (it auto-reconnects within ~30s) |
| Hermes says MCP server failed to connect | `hermes mcp test dt-browser`; bridge must be running |
| Port 18765/18899 busy | Choose two available ports outside Windows exclusion ranges, pass `--ws-port` and `--http-port`, and update the extension URL/footer, MCP clients and watchdog. Reload the extension and restart affected clients. |
| Extension code changed but behavior is old | Chrome caches the service worker script — reload the extension on chrome://extensions (or restart Chrome); a fresh Chrome for Testing profile for the E2E |

Other MCP clients can share the running HTTP bridge at
`http://127.0.0.1:18899/mcp`. Restart existing sessions after changing their MCP
configuration. Start the bridge with `--no-lifecycle` when using it without Hermes,
because the default lifecycle watcher follows Hermes instances.

## Files

```
extension/    MV3 extension (manifest, background service worker, content script, popup, settings page)
bridge/       bridge.py, cdp_endpoint.py (Playwright), authenticated relay_cmd.py, pyproject; bridge.log rotates at 1MB
scripts/      compact E2E, token benchmark, start/stop/autostart, CDP helper
tests/        stdlib bridge/relay tests plus async WebSocket boundary tests
test_site/    local test page used by the E2E
```

### Local application workflow checks

Install the fixture-only development dependencies with `npm ci --prefix jev-harness`.
`node --test jev-harness/test/workflow.test.js` serves a synthetic page on a temporary
loopback port and checks portal dropdowns, similar option labels, offscreen choices,
large Unicode source text replacement after focus changes, and saved state after reload.
The page distinguishes an inert preview button from a save that persists a revision
in localStorage. By default it creates its own headless Chrome profile and CDP port
and cleans up its browser and profile after the checks.

The `model-editor.html` and `monaco-editor.html` fixtures use actual
[CodeMirror](https://codemirror.net/docs/ref/#view.EditorView.state) and
[Monaco](https://microsoft.github.io/monaco-editor/typedoc/interfaces/editor_editor_api.editor.ITextModel.html)
document models. Their keyboard checks replace large Unicode documents, verify text
outside the rendered viewport, and compare models before and after two save/reload
cycles. Monaco uses LF and disables auto-indent to preserve exact source text. Its
empty EditContext has zero width; the check selects it by snapshot index after
focus moves to the decoy field. Click geometry uses its rendered parent surface,
then explicitly focuses the EditContext for background relay tabs. Visibility checks
cover the viewport edge, hidden parents, and parentless shadow-root controls.
Editor assets use a fixed local allowlist and pinned development dependencies.
CodeMirror serves native modules; Monaco and its worker are bundled in memory with
esbuild, replacing its vendored DOMPurify with patched 3.4.17. The build asserts that
the patched module is included and the vendored copy is excluded. No CDN is used;
the published harness still has no runtime dependencies. Arbitrary rich-text editors
are outside these checks.

For the actual extension and relay path, run:

```powershell
uv run --project bridge python scripts/browser_workflow_e2e.py --chrome "C:\path\to\Chrome for Testing\chrome.exe"
```

Use an extension-capable Chrome for Testing or Chromium executable. The runner copies
the extension, creates a temporary browser profile and token, and uses separate loopback
ports. It checks local UI commands through MCP, extension reconnection, and raw-CDP
tab detach, reattach, and close. It also runs all six application workflow checks,
including CodeMirror and Monaco snapshot selection, Unicode editing and save/reload,
through the extension's CDP relay, plus EditContext visibility at the viewport edge.
Test files run sequentially to avoid competing
keyboard focus. It does not use the standing bridge or browser profile.
The relay integration test is opt-in and runs through this runner; a missing browser
or failed prerequisite is an error. These checks need no model API key or external site.

E2E recipe (needs Chrome for Testing for --load-extension, since stable Chrome
137+ removed the flag): start an isolated development bridge
(`set DT_BRIDGE_ALLOW_NO_AUTH=1` then `bridge\start_bridge.cmd --no-auth --no-lifecycle`), serve the
test site (`python -m http.server 8900 --bind 127.0.0.1` in `test_site/`), launch
`%TEMP%\cft\chrome-win64\chrome.exe --user-data-dir=<tmp> --load-extension=<abs path to extension> http://127.0.0.1:8900/index.html --remote-debugging-port=9223`, wait for `/health` and extension authentication, then run `python scripts\e2e_compact_test.py`.

E2E status (Chrome for Testing, 2026-08-22): **32/32 checks passed** — tool
discovery/help, navigation, bounded text and snapshot pagination, accessible-name
filtering, click/type/wait, password redaction, positive and rejected upload paths,
path-only screenshots, tabs, and disable/re-enable. Separate async WebSocket
boundary tests passed **6/6** for Origin, role, auth deadline, repeated-auth and
slot ownership.
