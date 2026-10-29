# jev-harness

A browser tool for AI agents, driven by TypeSafe's **Jev**. Hand it a goal ("search Wikipedia for
Grace Hopper and report the year she was born"); a dedicated Chrome does the clicking at roughly
0.3 s per decision. The calling model (Claude, Hermes, …) makes **one** tool call and gets back a
status, the steps taken and the page lines that answer the goal. It never sees the intermediate pages.

**Why:** on the same three tasks (store price lookup, 4-field form, Wikipedia search), the orchestrating
model read **1,934 input tokens with jev-harness vs 163,575 with Claude-in-Chrome, 98.8% fewer (84.6×)**,
and 93,362 (48.3×) even with Claude-in-Chrome's failed clicks and retries removed. Jev's own usage for
those runs cost about $0.002. Details and caveats: [Token comparison](#token-comparison-2026-09-22).

Zero dependencies: Node 22.4+ built-in `WebSocket`/`fetch`, the raw Chrome DevTools Protocol and a
hand-rolled stdio MCP server. This folder is separate from dt-browser (the extension + bridge for your
real Chrome) and shares no code with it, but can drive your real Chrome through it: see
[Use your own Chrome](#use-your-own-chrome).

```
caller ──MCP stdio──► cli.js ──► engine.js (loop, budgets, stop gates)
                                   ├─► jev.js    one TypeSafe request per step
                                   └─► browser.js raw CDP → dedicated Chrome (port 9333)
```

## Requirements

- Node.js 22.4 or newer
- Google Chrome (found automatically; set `JEV_CHROME` to its path otherwise)
- A TypeSafe API key ([typesafe.ai](https://typesafe.ai)) in `TYPESAFE_API_KEY`

## Install

From a packaged tarball (build it with `npm pack` in this folder):

```bash
npm install -g ./dt-jev-harness-0.1.0.tgz     # puts `jev-harness` on PATH
```

Or run it from a checkout without installing: `node src/cli.js …` in place of `jev-harness …`.

## Configure

```powershell
setx TYPESAFE_API_KEY "<your key>"        # Windows (new terminals pick it up)
```
```bash
export TYPESAFE_API_KEY="<your key>"      # macOS / Linux
```

The key is looked up on every call, in this order: `TYPESAFE_API_KEY` in the server's environment, then
`TYPESAFE_API_KEY=` in the file named by `JEV_ENV_FILE`, then in the `.env` beside the dt-browser
folder (`../.env` from the repo root). The file fallback is for MCP hosts like Claude Desktop that keep
the environment they launched with: put the key in that `.env` and the next server process finds it
without restarting the host.

Logins for sites the agent should sign in to go in `~/.jev-harness/secrets.json` (or the `JEV_SECRETS`
env var as the same JSON), keyed by host. Subdomains match too:

```json
{ "www.example.com": { "username": "me", "password": "..." } }
```

Jev never sees these values. It only sees that a stored login exists. Code types the real values, and
snapshots, history and saved plans hold the markers `(stored username)` / `(stored password)`. Keep this
file out of any repository.

## Use

From a terminal (prints JSON):

```bash
jev-harness browse https://en.wikipedia.org/wiki/Main_Page "Search Wikipedia for Grace Hopper and report the year she was born."
jev-harness read https://example.com "what is this domain for?"
```

As an MCP server for Claude Code (user scope, every project):

```bash
claude mcp add --scope user jev-harness -- jev-harness mcp
# from a checkout instead: claude mcp add --scope user jev-harness -- node <path>/jev-harness/src/cli.js mcp
```

MCP tools:
- `browse(goal, url?, max_steps?, extract?)`: runs a whole goal.
- `browse_many(tasks[], concurrency?)`: runs independent goals in parallel tabs. Each result reports its own Jev usage.
- `read(url?, query?, extract?, elements?)`: reads a page without the agent loop. With `query`, it returns only the answering lines. The numbered element table comes back unless `query` or `extract` is set (`elements: true` asks for it anyway).
- `act(action, index?, text?, files?, ms?)`: manual takeover on the numbered elements that a failed `browse` returns.
  Actions: `click`, `type`, `submit`, `select`, `upload` (a `file` element + absolute `files`), `insert` (text at
  the focused element: code editors, chat boxes), `key` (`Escape`, `ArrowDown`, `Control+a`, ...), `wait_for`
  (text appears, or `!text` disappears), `enter`, `scroll_down`/`scroll_up` (the page, else the largest inner
  scroll container), `back`. Each returns `changes` (new page lines) and `scroll`.
- `read(..., screenshot: true)` adds a JPEG path of the visible page.
- `session_reset(url?)`: logs out of one site. It deletes the site's cookies (including parent-domain ones) and its
  localStorage/IndexedDB/cache, then reloads the live tab if it is on that site. Other sites keep their sessions.
  Omit `url` for the live tab's site.

`max_steps` also bounds cached replay. Each replayed action receives a fresh safety
decision, so the historical warm-cache costs below no longer describe its current
request count. Exact cached goals preserve literal case and whitespace; legacy
`plans.json` entries are ignored in favor of atomic entries under `JEV_HOME/plans-v2`.
Exhaustive list goals accumulate items across pages and require evidence of the end;
a partial collection is returned without claiming completion.

`extract` returns `data` in a caller-given shape, e.g. `{"title": "book title", "price": {"type": "number",
"description": "price incl. tax"}}` (types `string`/`number`/`integer`/`boolean`/`list`; a `list` is every page line that is an item, one Noul per line in the same request), plus a per-field
`confidence`. All fields cost one Jev request. Numbers are picked from the page's own number tokens and
strings from its lines, so no value is invented. A field that is absent comes back `null`.

Environment variables:

| Variable | Effect |
|---|---|
| `JEV_HEADLESS=1` | Headless Chrome |
| `JEV_CDP_PORT` | DevTools port (default 9333) |
| `JEV_CHROME` | Chrome executable |
| `JEV_PROFILE` | Browser profile (default `~/.jev-harness/chrome-profile`) |
| `JEV_MODEL` | Jev model (default `jev-1.14.0`, pinned). 1.14 tied 1.13 on the held-out dev split (10/13 each, same tasks failing, 6% fewer tokens; n=1 rep, 2026-10-17: bench/heldout-dev-m113/m114.json). Results report the answering model in `jev.model` |
| `JEV_ALLOWED_ORIGINS=host1,host2` | A run that navigates elsewhere stops `blocked_origin`; `read`, `act` and `session_reset` refuse other hosts too |
| `JEV_ALLOW_IRREVERSIBLE=1` | Without it, an action Jev rates ≥ 0.65 likely to commit something the goal did not ask for stops `needs_confirmation` |
| `JEV_NO_MEMORY=1` | Disable plan replay and learned search URLs |
| `JEV_HOME` | Plans, secrets file and failure screenshots (default `~/.jev-harness`) |
| `JEV_BRIDGE=1` or `ws://host:port` | Drive your own Chrome through dt-browser's extension and bridge instead of a dedicated Chrome (`1` = `ws://127.0.0.1:18765`). See [Use your own Chrome](#use-your-own-chrome) |
| `JEV_BRIDGE_DIR` | dt-browser `bridge` folder to auto-start when no bridge is running (default: `../bridge` when run from the checkout; an `npm install -g` copy needs it set) |
| `DT_BRIDGE_TOKEN` / `JEV_BRIDGE_TOKEN_FILE` | Bridge token for `JEV_BRIDGE` (default: `token.txt` in the bridge folder) |
| `JEV_TRACE=<file>` or `1` | One JSON line per Jev request (question ids, option counts, state size, tokens, latency; no page text, goals or typed values). `1` writes `~/.jev-harness/trace.jsonl` |

Statuses:
- `done` / `goal_achieved`: verified by on-page evidence.
- `unverified`: Jev voted done twice, but the evidence check stayed low.
- `stuck`, `needs_confirmation`, `blocked_origin`, `max_steps`, `timeout`, `error`.

Every result carries `jev.cost_usd`. A failed run also carries the element table and a screenshot path.

## Use your own Chrome

With `JEV_BRIDGE=1`, jev-harness runs in the Chrome profile you use every day, with its logins and cookies,
through the dt-browser extension (which carries the same DevTools Protocol over `chrome.debugger`). A call
with a url works in a tab you already have open on that site, else in the tab jev-harness used before, else in
one new background tab in your current window; a call without a url continues in the last call's tab. Your own
tabs are never closed, and `browse_many` closes only the extra tabs it opened.

1. Load or reload the dt-browser extension (`<repo>\extension`) in `chrome://extensions` and accept its
   "debugger" permission. Its popup must show connected, with the bridge token saved.
2. The bridge starts on its own: when the MCP server launches (or a run starts) and nothing answers on the
   default port, jev-harness starts this checkout's `bridge` with `uv run python bridge.py --no-lifecycle`
   (`JEV_BRIDGE_DIR` points it at another checkout), then waits up to 20 s for the extension to connect.
   Chrome must be open.
3. Register the MCP server with the flag:
   `claude mcp add --scope user jev-harness --env JEV_BRIDGE=1 -- node <repo>/jev-harness/src/cli.js mcp`

Each tool call attaches to its tab only for its own duration, so Chrome's "is debugging this browser" banner
shows only while a call runs (pressing Cancel ends it). Start Chrome with `--silent-debugger-extension-api` to
hide the banner altogether; that hides it for every extension using `chrome.debugger`.
`session_reset` deletes that site's cookies and storage in your real profile, so it logs you out there.
`JEV_HEADLESS`, `JEV_CDP_PORT`, `JEV_CHROME` and `JEV_PROFILE` do not apply in this mode.

## Test

```bash
npm test                      # 52 tests (node --test; live checks need Chrome + the bench site)
python -m http.server 8911    # in bench/site, for the live suite's local tasks
JEV_HEADLESS=1 node bench/suite.js   # 9-task live suite (needs Chrome + TYPESAFE_API_KEY)
```

## Techniques, and where they came from

| Technique | Source |
|---|---|
| Page state as an indexed element table, so Jev picks an index and never writes a selector; offscreen controls are kept and scrolled into view on choice | [jev-ultrafast](https://github.com/browser-use/jev-ultrafast), [ultrabrowse](https://github.com/narekgevorgyan/ultrabrowse) |
| One request per step: action Choice + `goal_met` Noul + `stuck` Noul, stopping when either Noul exceeds 0.85 | [jkudish/jev-browser](https://github.com/jkudish/jev-browser), [fan-out](https://docs.typesafe.ai/patterns/fan-out.md) |
| `search_N` (type and submit in one action) vs `type_N` (fill only) vs `submit_N` (fill + Enter) | jkudish/jev-browser |
| A repeat with no effect falls to the next-best option in the Choice distribution | jkudish/jev-browser |
| Strict answer validation: an unoffered option or a malformed distribution never executes | ultrabrowse |
| Consent banners dismissed in code; the covered-target check falls back to `el.click()`; popups adopted (only tabs whose `openerId` is ours) | ultrabrowse, hardened after review |
| **New: typed text is *selected*, not generated.** Code enumerates candidate spans from the goal (quotes, emails/URLs/numbers, word runs not bounded by stopwords). A speculative `text_N` Choice per field is asked in the same request, so no second LLM or API key is needed. ultrabrowse and jkudish/jev-browser both require one (jkudish's keyword fallback is "meaningfully worse"); moritzkremb/jev-voice-browser also picks regex spans with Jev | [value extraction cookbook](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook.md) |
| **New: DONE needs two agreeing judgments.** The `done` choice is accepted only when `goal_met` ≥ 0.5; otherwise the next-best action runs | [confidence routing](https://docs.typesafe.ai/patterns/confidence-routing.md) |
| **New: evidence instead of page dumps.** At the end, a line-ID Choice plus an `exists` Noul return only the lines that answer the goal | [semantic find cookbook](https://docs.typesafe.ai/cookbooks/semantic_find.md) |
| **New: code-side pruning.** Off-screen elements are ranked by word overlap with the goal and trimmed to fit the Choice option cap | [jev-1.13 jaggedness #5](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md) |
| Dropdown option picked speculatively in the same request (`option_N`), not in a second call | fan-out |

### Second pass (2026-09-22): research-driven improvements

A wider 9-task suite (`bench/suite.js`) showed the first version wandering on "report X" goals and on
long pages. These changes came out of the literature and the other Jev browsers:

| Change | Source | Effect on the suite |
|---|---|---|
| **Completion verifier.** A stop (Jev votes `done`, `goal_met` > 0.85, or `outcome_visible` ≥ 0.8) is accepted only if the evidence check finds the outcome on the page; a vetoed vote continues, a second vote ends the run `unverified` | VLAA-GUI [arXiv:2604.21375](https://arxiv.org/abs/2604.21375), FCPAgent | `cart` no longer stops before the item is added |
| **Probability floor 0.1 + revisit-count loop detector.** Actions below the floor are noise; a page seen 3 times ends the run instead of A/B/A/B wandering | AgentOccam [arXiv:2410.13825](https://arxiv.org/abs/2410.13825) (removing distractor actions alone cut tokens 25%), VLAA-GUI | `sort` 16 → 3 calls, `catalog` 12 → 6 |
| **Tiered element pruning to 60.** Elements whose label shares words with the goal first, then controls over plain links; one compact line per element instead of a JSON object; speculative text questions only for the 3 likeliest fields | Prune4Web [arXiv:2511.21398](https://arxiv.org/abs/2511.21398), AgentOccam | Wikipedia step ≈ 7K tokens instead of 10K |
| **Compound form fill.** All confident field/option picks from one request are applied in one step | WebChallenger [arXiv:2606.10423](https://arxiv.org/abs/2606.10423) (compound actions cut steps 27%) | `form` 8 → 6 calls, −46% tokens |
| **Capped evidence document.** 120 goal-relevant lines × 200 chars instead of 250 × 300 | semantic-find cookbook | Wikipedia evidence call ≈ 6K instead of 15K |
| **Plan cache with replay.** A verified run stores its page-changing steps by (site, goal), detours collapsed; a repeat replays them by role+label with one Jev call (the evidence check) and falls back to the loop on any missing element | Agentic Plan Caching [arXiv:2506.14852](https://arxiv.org/abs/2506.14852), Agent Workflow Memory [arXiv:2409.07429](https://arxiv.org/abs/2409.07429). No other Jev browser has cross-run memory | warm runs: 1 call, ~750 tokens on the store tasks |
| **Irreversible-action gate, origin allowlist, USD cost, failure screenshot, `browse_many`** | fastbrowse (`safety.py`), cline jev-browser (`allowedOrigins`), jkudish (`est_cost_usd`), ultrabrowse (`browse_many`, screenshot on failure) | feature parity |

**Suite results** (`bench/suite.js`, 9 tasks: store search/open/report, 4-field form, sort a list,
click-only open, add to cart, 200-link catalog, an impossible login, two Wikipedia lookups). Jev input
tokens, median per task; "cold" is a fresh goal, "warm" is the same goal replayed from the plan cache.

| | success | Jev calls | Jev tokens (9 tasks) | vs baseline |
|---|---|---:|---:|---:|
| v1 (first commit), 2 reps | 12/18 | 68 | 194,377 | — |
| v2 cold, 3 reps, memory off | **27/27** | 37 | 78,419 | **−58%** |
| v2 warm (replayed plan), 1 rep | 9/9 | 13 | 26,148 | **−87%** |

Per task, v1 → v2 cold: `sort` 36.4K → 4.8K (16 → 3 calls, 0/2 → 3/3), `catalog` 28.6K → 11.8K,
`impossible` 20.2K → 6.5K, `form` 18.1K → 9.8K, Wikipedia ≈ 31K → 14K. Warm store tasks cost one
call (the evidence check, ~750 tokens). The `impossible` task and a run where Wikipedia served a
banner do not replay, by design (no verified plan). Across 5 Wikipedia runs one ended `stuck` on such
a banner. Raw rows: `bench/suite-*.json` (`v3` is the post-review run the warm row comes from).

**Real e-commerce pages** (`bench/real_sites.js`, headed Chrome, memory off). The question was whether
the 60-element pruning budget holds on real pages. It did: every goal-relevant control survived pruning,
including on eBay's 268–400-element pages. The two problems found were different, and both are fixed:
icon-only buttons had no label (now the `id`/icon class is used, e.g. "submit search"), and the
per-step text window was the first 3000 chars, all header on big pages (now the opening lines plus
goal-relevant lines). A submit that changes nothing now falls through to the button after the field.

| site | raw elements | status | Jev calls | Jev tokens |
|---|---:|---|---:|---:|
| books.toscrape.com, open category → first price | 114 | done | 3 | 8,153 |
| books.toscrape.com, open title → price | 114 | done | 2 | 5,784 |
| demoblaze.com, category → product → price | 34 | done | 3 | 4,952 |
| automationexercise.com, search → first product | 66 | done | 5 | 16,151 |
| ebay.com, search → first listing price | 400 | done (1 of 2 runs) | 6 | 24,005 |

eBay intermittently serves its "Something went wrong" page to automation (headless always, headed
once in two); the run then stops `stuck` in 4 calls. *Update 2026-09-23:* that page is an **HTTP 403**
on a search URL that loads fine a moment later (5 of 12 probe runs, same URL); one reload cleared 4 of 5.
A GET whose main document returns 403/429/5xx is now reloaded once after 1 s (never a POST, which
would resubmit a form); the run's `notes` say so. eBay then passed 10/10 through the engine plus the
real-site bench, though its 403 rate varied by the hour (0 of 12 in a later probe), so this is a
mitigation, not a guarantee against a site that keeps blocking. The snapshot cap was raised from 400 to 800
elements so pruning sees the whole page. Local suite after these changes: cold 9/9 at 87K tokens
(+8% from the goal-aware text window), warm 9/9 at 26K.

**Logged-in flows** (saucedemo.com, public demo account). Password fields were the one control the
harness never offered. They now work through an origin-scoped credential channel: `JEV_SECRETS`
(JSON) or `~/.jev-harness/secrets.json` maps a host to `{username, password}`. Jev sees only that a
stored credential exists (a `password_N` action and a "(stored username)" text option); code types
the value, the snapshot shows `••••`, and history, results and plans carry the markers, never the
value. Cold: username + password filled in one step, Login clicked, first product reported — 4 calls,
6.2K tokens. Warm replay: 1 call. Without credentials the run stops in 2 calls with a note saying
which file to set. `act` accepts the same markers for manual takeover.

**Live sessions** (`bench/session.js`, saucedemo, 4 goals after login: sort, open product, add to
cart, read cart). The MCP server keeps one tab and the dedicated profile keeps cookies, so a caller
can log in once and then run goals; a goal without `url` continues in the live tab and still gets
plan replay (keyed on the page it starts from).

| regime | goals ok | Jev calls | Jev tokens / goal |
|---|---|---:|---:|
| log in inside every goal (fresh tab, site data wiped) | 4/4 | 20 | 8,173 |
| log in once (6.0K), then goals in the live tab, cold | 4/4 | 10 | 4,299 |
| same session, goals repeated (plan replay) | 4/4 | 6 | **2,105** |

A live session halves the per-goal cost; plan replay on top halves it again (−74% vs fresh). Goals
whose answer is visible on arrival (0 steps) cost 2 calls either way; replay only helps goals with steps.

Getting there surfaced three bugs, all fixed:
- **Chrome's "Save password?" bubble swallows every page click** after any password-form submission.
  Nothing reached the page (not even `mousedown` on `document`) until the tab was closed. The launch
  flags do not cover it; the harness now writes `credentials_enable_service: false` (plus
  password-manager and leak-detection off) into the profile preferences before starting Chrome.
- Generic item buttons ("Remove", "Add", "Delete"…) now always carry their item's name, not only when
  duplicated. A lone "Remove" had let Jev toggle an item back out of the cart.
- Plan replay now records what changed (e.g. "+button Remove — Sauce Labs Bike Light"), so the evidence
  check can verify replayed actions whose only effect is a state change.

Site state (cookies, localStorage) persists in the dedicated profile across runs. That is what makes
sessions work; `session_reset` (used by the benchmarks per regime) clears one site on demand.

### Third pass: measured token budget (2026-09-22)

A per-request trace of the cold suite showed where Jev tokens went: 73% step decisions (of which 47%
the action Choice, 20% page text, 11% speculative text picks, 16% four Nouls) and 26% evidence checks.
Every run ended with two requests on the same page: the stop vote, then the evidence check.

| Experiment | Jev tokens | Calls | Success | Kept? |
|---|---:|---:|---|---|
| Baseline (v8) | 80,998 | 35 | 9/9 | — |
| Element list in `state`, option criteria `null` (semantic-find pattern) | +3% | +2 | 9/9 | **no**: only −4% per step, and the index indirection cost Wikipedia 2 extra steps |
| Merge `goal_met` into `outcome_visible` | −2% | 35 | 9/9 | yes |
| Evidence document 120 → 60 lines | −1% | +2 | 9/9 | **no**: wiki −22% but wiki2 lost its answer line |
| Text window 3000 → 2000 chars | **+36%** | +7 | 8/9 | **no**: stop Nouls stop seeing outcomes |
| Speculative evidence inside every decide request (all text lines) | −7% | 27 | 9/9 | superseded |
| Same, top-25 goal-relevant lines as options, fallback to the full check | **−12%** | **27** | 9/9 | **yes** |
| Same, gated off after low-outcome steps | +7% | 32 | 9/9 | **no**: the step before a stop is usually low-outcome |

**Adopted** — each decide request also asks *where* (a Choice over the 25 lines of the text window
likeliest to hold the answer) and *exists* (a Noul). A stop vote whose inline evidence clears the bar
ends the run with no second request; otherwise the full evidence check runs as before. Result: local
suite cold 81.0K → 71.1K tokens and 35 → 27 calls (9/9; Wikipedia −40%); saucedemo per goal 7.9K fresh /
3.8K live session / **1.8K** session + replay (12/12). A real-site rerun also hardened the "Enter did
nothing → click the adjacent search button" rule to trigger on "URL did not change" instead of "page
did not change", since ads and live widgets make almost every page change.

Not adopted: state-diff observations (Region4Web, Read-More-Think-More) do not apply to a stateless
per-request API; FocusAgent-style model-based line retrieval would cost a call per line.

### Fourth pass (2026-09-23): held-out evaluation, generalised memory, frames

| Change | Source | Measured |
|---|---|---|
| **Held-out task set** (`bench/heldout.js`, [bench/heldout.md](bench/heldout.md)). 25 tasks on 13 untuned real sites, split by site into dev and test | WebVoyager-style | **Out-of-sample success 63%** (test, dev-chosen config), against 100% on the tuning suite. Two bugs found on dev and fixed (dev 62% → 77%). The one threshold change dev suggested (`OUTCOME_STOP` 0.5) failed on test and was rejected |
| **Plans with blanks.** The goal values a verified plan used become slots, and a goal with the same wording and other values replays with them bound, in code | Agent Skill Induction [arXiv:2504.06821](https://arxiv.org/abs/2504.06821), AWM [arXiv:2409.07429](https://arxiv.org/abs/2409.07429) | New-value goals: 1 Jev call / 0.9–2.9K tokens vs 3–4 calls / 6.9–19.6K cold, 6/6 correct ([bench/templates.md](bench/templates.md)) |
| **Learned search URLs.** A search that lands on a URL carrying the query teaches that site's URL pattern (search-like fields only, ids/tokens dropped); later searches navigate to it directly | Skim [arXiv:2605.16565](https://arxiv.org/abs/2605.16565) | automationexercise: 3 → 1 steps on replay (the "Enter did nothing → click the button" detour is gone), 4.3 s → 2.1 s |
| **`extract` into a JSON shape** from `browse`/`read`/`browse_many` | pre-parsed value extraction cookbook | 1 request for all fields; 11/12 fields exact across books.toscrape, Wikipedia, scrapethissite and the store (the 12th, "universities attended", returned the whole paragraph that names them) |
| **Open shadow DOM, same-origin and cross-origin iframes.** Shadow roots and same-origin frames are walked in the snapshot. Out-of-process frames are attached with `Target.setAutoAttach` (flat sessions) and hit-tested at the top level too. Their elements carry their own URL, so stored credentials are never typed into another site's frame, and `JEV_ALLOWED_ORIGINS` applies to frames | fastbrowse (auto-attach) | New fixtures (`shadow.html`, `frames.html`, `login_frames.html`) go from 0 to all elements; 3/3 browse goals on them. The-internet nested frames: read |
| **Per-task Jev usage in `browse_many`** (async-context counters instead of one shared total) | — | Parallel results now sum to the total (4,125 + 9,377 = 13,502) |
| **Settling on quiet.** Wait for load, no XHR/fetch in flight, and 50 ms without DOM mutations, instead of fixed sleeps | jev-ultrafast | Local store tasks −28% wall time (29.4 s → 21.2 s over 2 reps), same tokens. Wikipedia is bound by network and Jev latency and did not improve |
| **`JEV_TRACE`** request log, kept permanently | third-pass tuning | one line per request |

An independent review of the change found one critical issue, fixed before the held-out runs: a stored
password could be typed into a cross-origin iframe's password field. It is now covered by a live test
that fails when both guards are removed. The review also led to these fixes:
- template bindings must name exactly one element;
- search URLs drop the learning run's ids and tokens and are forgotten after an unverified run;
- frame clicks are refused when an overlay covers the frame;
- hidden shadow text is excluded;
- decimal-comma and hyphenated numbers parse correctly.

## Token comparison (2026-09-22)

The same three tasks were run in each system: a store search followed by opening the right product
and reporting its price, a 4-field newsletter signup, and a Wikipedia search with a birth year. The
metric is **the orchestrating model's input tokens**. Each turn re-reads the tool catalog plus all
earlier tool traffic, and N tool calls make N+1 turns. Reproduce with `bench/token_bench.py`; raw
payloads are in `bench/results.json`.

| System | Tool calls (3 tasks) | Cumulative input tokens | vs jev-harness | Success |
|---|---:|---:|---:|---|
| Claude-in-Chrome, as run | 39 | 163,575 | 84.6× | 3/3 |
| Claude-in-Chrome, clean path (silently failed actions and their retries removed) | 24 | 93,362 | 48.3× | 3/3 |
| dt-browser compact profile (scripted near-optimal path; re-reads when the page lags) | 27 | 67,691 | 35.0× | 3/3 |
| **jev-harness** | **3** | **1,934** | 1× | 3/3 |

Per-task rows are in [bench/results.md](bench/results.md). Jev's own usage for the three runs was 15
calls and 55,463 input tokens. That is billed by TypeSafe at $0.042/Mtok, about $0.002 in total.
Repeatability: jev-harness passed 12/12 runs (the benchmark run plus 3 repeats of each task), plus a popup-tab fixture. Median
wall time was 2.1 s for price, 4.2 s for the form and 2.4 s for wiki.

Caveats:
- Tokens are counted with tiktoken `o200k_base` on compact JSON, the same method as
  `scripts/token_benchmark.py`. That approximates Claude's tokenizer.
- Screenshots use Anthropic's ⌈w/28⌉·⌈h/28⌉ rule.
- System prompt and prose are excluded.
- Claude-in-Chrome was driven live by Claude Code in a real Chrome. Its type/click/Enter actions
  silently failed several times, which is why the clean path is reported too.
- dt-browser was scripted along the path a careful model would take. Its row is a near-lower bound,
  not a model run.
- n = one run per system per task for the token rows. The tasks are small, so treat the ratios as
  indicative.

## Limits

- Jev cannot generate text. A field whose value is not stated in the goal is left empty, and the run
  stops `stuck` with the element table so the caller can use `act`.
- File inputs are never offered. Password fields take a stored credential, or a password stated in
  the goal (typed but never echoed: steps show `(password from goal)`, and such runs are not saved as plans).

For Claude Code, register it as a user-scope MCP server (above) and copy the repo's `skills/jev-browser/`
folder to `~/.claude/skills/` so browser tasks route here instead of claude-in-chrome; the skill also
covers setup and a health check. Verified from a fresh `claude -p` session: a saucedemo login + sort + report task ran as
one `browse` call (3 turns).
- Canvas widgets and closed shadow roots created declaratively (`<template shadowrootmode="closed">`)
  are not indexed. Closed roots created by `attachShadow` are: a hook installed before page scripts keeps
  a reference, and the root stays closed to the page. Cross-origin frames at any depth are indexed:
  new frames are held at start until the hook and auto-attach are in place.
- False "done" answers (an on-topic line that doesn't answer, like "Capital: Pago Pago" for Belize) are
  checked since 2026-09-23. Evidence is ranked by rare-word relevance with neighbour lines, and a small
  answer check runs before a report goal stops. On a fresh 11-site held-out set: 83% → 95% success,
  4 → 2 false-positive stops (the 2 left give a vaguer but true "BSD licensed"). See
  [bench/heldout-v2.md](bench/heldout-v2.md).
  The remaining vague-but-true answers ("BSD licensed" instead of `License: BSD-3-Clause`) came from
  stopwords counting in relevance. That is fixed, a unique labelled field is now preferred over prose,
  and "open …" goals must navigate before stopping. On a third fresh set (8 sites of package/record
  metadata): 86% → 90%, 2 → 0 false-positive stops ([bench/heldout-v3.md](bench/heldout-v3.md)).
- The dedicated profile has no logins. For logged-in work in your real Chrome, use dt-browser.

`npm test` runs the unit checks for span enumeration and answer validation, plus live safety checks.
The live checks need Chrome and the bench site: `python -m http.server 8911` in `bench/site`. They
cover three things:
- banner dismissal never clicks OK in a generic modal;
- `confirm()` is dismissed;
- a closed tab fails fast.

Dialogs: `alert`/`beforeunload` are accepted and `confirm`/`prompt` are dismissed; all are reported
under `dialogs`.
