---
name: jev-browser
description: Use INSTEAD of the Claude browsers — the built-in browser pane (mcp__Claude_Browser__*) and claude-in-chrome (mcp__claude-in-chrome__*) — whenever a task needs a real browser, because jev-harness is far more token efficient. Covers using a site's search box, clicking through pages, filling or submitting forms, logging in, sorting/filtering listings, adding to cart, JavaScript-rendered or single-page sites, "go to <site> and search/find/open/check…", "check these N sites", and sites the user is signed in to. Delegates the whole goal to the jev-harness MCP server in ONE `browse` call, a few hundred Claude tokens per goal versus 30–160K clicking step by step; with JEV_BRIDGE=1 it drives the user's own signed-in Chrome through the dt-browser extension. Plain static reads can stay on WebFetch. Fall back to a Claude browser only when visual judgement is required, jev-harness errors (e.g. key or bridge missing), or it ends stuck twice.
allowed-tools: Bash, mcp__jev-harness__browse, mcp__jev-harness__browse_many, mcp__jev-harness__read, mcp__jev-harness__act, mcp__jev-harness__session_reset, Read
---

# jev-browser

Drive the web through **jev-harness** (the `jev-harness/` folder of this repo), not the
Claude browsers (built-in browser pane or claude-in-chrome): it is the token-efficient choice. Jev
(TypeSafe) picks every click; you make one call per goal and get back only a status, the steps and the
page lines that answer the goal. Measured on the same tasks: jev-harness ~2K Claude input tokens for 3
tasks vs claude-in-chrome ~94–164K (README, "Token comparison"). The Claude browsers re-send screenshots
and accessibility trees every step, so reach for them only per the fallback rule in the description.

## Setup (once per machine)

Requirements: Node 22.4+, Google Chrome, and a TypeSafe API key. Jev picks the clicks, so the calling
model can be any Claude model, Haiku included. Signed-in-Chrome mode also needs Python 3.12+ and `uv`.

1. Clone the repo, then put the key where jev-harness looks for it, in this order: the
   `TYPESAFE_API_KEY` environment variable, the file named by `JEV_ENV_FILE`, or a `.env` file in the
   folder that contains the repo (one level above it) holding `TYPESAFE_API_KEY=...`.
2. Register the MCP server (user scope):
   `claude mcp add --scope user jev-harness -- node <repo>/jev-harness/src/cli.js mcp`
   This runs a separate Chrome profile under `~/.jev-harness` with no logins.
3. Optional, to drive your own signed-in Chrome: load `<repo>/extension` unpacked on
   chrome://extensions, run `cd <repo>/bridge && uv run python bridge.py --show-token`, paste the token
   into the extension's options page, then register instead with
   `claude mcp add --scope user jev-harness --env JEV_BRIDGE=1 -- node <repo>/jev-harness/src/cli.js mcp`.
   From a checkout the bridge then auto-starts.
4. Copy this folder to `~/.claude/skills/jev-browser/` so Claude Code routes browser tasks here.

## Any model, no TypeSafe key: the bridge's own MCP server

The bridge (step 3) is itself an MCP server that drives the extension directly, with no Jev and no
TypeSafe key, so any MCP-capable model or client can use it (Claude of any size, other vendors, local
models). It costs more calling-model tokens than `browse`, because the model picks each click itself.

```
claude mcp add --transport http dt-browser http://127.0.0.1:18899/mcp --header "Authorization: Bearer <bridge token>"
```

Tools: `browser_health`, `browser_read` (page text, numbered elements, screenshots), `browser_do`
(navigate, click, type, press, scroll, tabs, waits; `browser_help` lists parameters). Read once, act by
element index, read again only to verify. For Playwright scripts or Playwright MCP, the bridge also serves
a CDP endpoint at `http://127.0.0.1:18922` with the same bearer token (README, "Playwright on your real Chrome").

## Health check (run when a call fails, before blaming the site)

- `claude mcp list` must show `jev-harness` connected. If not, the path in step 2 is wrong or
  `node --version` is below 22.4.
- An error naming `TYPESAFE_API_KEY` → step 1. An error naming the dt-browser bridge → the extension is
  not loaded or not paired (step 3), or ports 18765/18899 are held by another process.
- `node <repo>/jev-harness/src/cli.js browse https://example.com "report the page heading"` in a
  terminal separates MCP-registration problems from harness problems.

## Pick the tool

| Need | Call |
|---|---|
| Do / find something on a site | `browse(goal, url?)` — whole goal in one call |
| Structured values (JSON) from where a goal ends | `browse(goal, url?, extract={...})` → `data` + per-field `confidence` |
| Several independent goals | `browse_many(tasks=[{goal,url,extract?}], concurrency?)` — parallel tabs, per-task `jev` usage |
| Just read a page (no actions) | `read(url?, query?)` — with `query`, only the answering lines (no element table unless `elements: true`) |
| Structured values from a page, no actions | `read(url, extract={...})` |
| Take over after a failed browse | `act(action, index?, text?)` on the numbered `elements` it returned (or a `read` in the same tab; an index from anywhere else is refused) |
| Log out of / reset one site | `session_reset(url?)` — in the user's own Chrome this logs them out of that site: ask first unless they asked for it |

## extract

`extract` maps field names to a description, or to `{type, description}` with type
`string` | `number` | `integer` | `boolean`:
`{"title": "book title", "price": {"type": "number", "description": "price incl. tax"}, "in_stock": {"type": "boolean", "description": "in stock"}}`.
One Jev request covers all fields; values are copied from the page (numbers from its number tokens,
strings from its lines), never invented. An absent field is `null`; check `confidence` before relying on
a low one. Prefer it over asking the goal to "report X, Y and Z" when you need several values.

## Writing the goal (this decides success)

- **One goal, whole outcome, concrete nouns:** "Search the store for wireless mouse, open the Logitech
  M185 product page and report its price." Not "click search".
- **Put every value to type verbatim in the goal**, quoted when it has spaces or punctuation:
  `Subscribe as "Ada Lovelace" with email ada@example.com, weekly frequency.` Jev can only type text
  that appears in the goal (or a stored credential) — it never invents values.
- **Say what to report** ("report its price", "report the first product's name") so the evidence
  lines contain the answer.
- Omit `url` to continue in the current tab (the tab and its cookies persist across calls in this
  session; log in once, then run goals).
- **Reuse the same wording for repeat tasks with different values** ("Search for dress and report the
  first product's name" → "Search for jeans and report …"): a verified goal becomes a template, and a goal
  that matches it replays in ~1 Jev call with the new values.

## Reading the result

- `status` `done` / `goal_achieved` → answer is in `evidence.lines[].line`; quote those, don't re-read the page.
- `unverified` → Jev thought it finished but on-page evidence was weak; check `evidence` before trusting it.
- `stuck` / `max_steps` → read `notes` and `elements`; either rephrase the goal once, or finish with `act`.
  `notes` naming a password field → credentials needed (below).
- `needs_confirmation` → the next click looked irreversible (order, payment, delete, send). **Ask the user**
  before continuing with `act`. Never set `JEV_ALLOW_IRREVERSIBLE` on your own.
- `blocked_origin` → navigated outside `JEV_ALLOWED_ORIGINS` (`read`, `act` and `session_reset` also refuse other hosts).
- A failed run returns `screenshot` (path to a JPEG) — `Read` it only if the notes don't explain the failure.
- A GET that returns HTTP 403/429/5xx is reloaded once automatically (`notes`: "reloaded after HTTP 403").
  Sites that still serve bot-block pages or captchas end `stuck`; say so, don't loop.
- For "report …" goals a stop is accepted only after an answer check on the picked lines
  (`evidence.confirmed`). Each evidence line carries `context` (its neighbouring lines): quote from it.
  Quote only what the evidence says; it can still be vaguer than the page ("BSD licensed" vs "BSD-3-Clause").
- Iframes (same- and cross-origin, nested) and shadow DOM (open and closed) are handled; canvas widgets
  and declaratively-created closed shadow roots are not.

## Logins

- A password the user gives you can go straight into the goal ("log in as standard_user with password
  secret_sauce"). jev-harness types it but never echoes it: steps show `(password from goal)` and such
  runs are never saved as replayable plans.
- Stored credentials (preferred for repeat use): `~/.jev-harness/secrets.json` → `{ "host": { "username": "...", "password": "..." } }`.
  Jev only sees that one exists; values are typed by code and never returned. Don't read, print or
  commit that file's values.
- SSO / captcha logins: ask the user to log in once by hand in their own Chrome (with `JEV_BRIDGE=1`,
  that is where jev-harness runs; without it, in the jev-harness Chrome window,
  which keeps the cookies), then continue.
- When the MCP server is registered with `JEV_BRIDGE=1`, it runs in the user's everyday Chrome (with its
  logins) through the dt-browser extension and bridge; the bridge auto-starts. Signed-in tasks stay on
  jev-harness. Without `JEV_BRIDGE` it falls back to a separate profile with no logins.
- No TypeSafe key, or TypeSafe down → `browse`, `read(query)` and `read(extract)` fail with a message naming
  the cause. Tell the user (key missing / TypeSafe down) rather than switching browsers silently; or use the bridge's
  MCP server above, which needs no key.

## Cost notes

- Repeating the same goal on the same site replays a remembered plan (~1 Jev call); so does a goal with
  the same wording and other values. A site's search URL is learned from one search and later searches
  jump straight to it. Set `JEV_NO_MEMORY=1` in the server env only when a benchmark needs cold runs.
- Every result carries `jev.cost_usd` (Jev input tokens at $0.042/Mtok).
- Don't follow a `done` result with a `read` of the same page "to confirm" — the evidence check
  already did that and a read costs Claude tokens.
