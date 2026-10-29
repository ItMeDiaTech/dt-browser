# False "done" answers: fix and fresh held-out check (2026-09-23)

## The problem

On the first held-out test split, 4 of 24 runs ended `done` with a wrong answer. The evidence check
accepted a line that was on topic but did not answer the goal:

| task | returned | why |
|---|---|---|
| scrapethissite: capital of Belize | "Capital: Pago Pago" | 250 lines say "Capital: …". Word overlap tied them all, so the "Belize" line never reached the evidence window. Its capital sits on the next line anyway |
| Open Library: author of The Hobbit | "The Hobbit" | the author ("by J.R.R. Tolkien") is on the line after the title. The whole-document `exists` Noul still said yes |

## The fix (`src/jev.js`, `src/engine.js`, `src/browser.js`)

1. **Rarity-weighted relevance.** A goal word counts `log(1 + lines / lines-containing-it)`, so "belize"
   (1 line) outweighs "capital" (250 lines). Used for the step text window, the inline evidence
   options and the evidence document.
2. **Neighbour lines.** Every ranked line brings the lines after and before it, because records span
   lines. Evidence entries now carry a `context` field with the picked line and its neighbours.
3. **Answer check before a stop.** For goals that ask for information (report / what / who / how
   many …), one small Noul looks at the top two picked lines with their neighbours. It also sees the
   page title and URL, and the last action's change line. The question is "Could `query` be answered
   by quoting these lines, given the page they come from?" and it needs ≥ 0.5.
   - If the inline evidence fails the check, the full evidence request runs before the stop is vetoed.
   - Action goals skip the check: "Welcome back, ada" answers "sign in" but states no value.
4. Unselected `<option>` texts are dropped from the page lines. `innerText` lists every option, and a
   stray "Price: high to low" above a list sorted low to high made the check fail.

The wording was chosen on 6 cases captured from the dev data (correct ≥ 0.85, wrong ≤ 0.15). Two
stricter wordings separated them less well.

## Development data (the earlier held-out sets, now used for development)

| set | before | after | false-positive stops |
|---|---:|---:|---|
| old test (6 sites) | 18/24 | 22/24 | 4 → 0 |
| old dev (7 sites) | 20/26 | 20/26 | 0 → 0 |
| tuning suite | 9/9 | 9/9 (2 reps) | — (+6 calls, +3% tokens) |

## Fresh held-out set (`split: "fresh"` in bench/heldout.js)

- **What it is:** 23 tasks on 11 sites that no tuning had touched: Gutenberg, pkg.go.dev, RubyGems,
  Packagist, NuGet, IANA, RSC periodic table, W3Schools, expandtesting, crates.io and gnu.org. It
  includes table and record lookups, where false positives come from.
- **How it was built:**
  - Written after the fix was frozen (commit `3449d89`).
  - Expected values were read from the live pages independently.
  - Scored once for the pre-fix code (`b507add`, run from a git worktree) and once for the fixed code.
  - 2 reps each, memory off, headed Chrome.
  - Nothing was changed after seeing the results.

| code | success (all 46 runs) | success, gnu.org excluded (42) | false-positive stops | Jev tokens (excl. gnu) | calls |
|---|---:|---:|---:|---:|---:|
| pre-fix `b507add` | 35/46 (76%) | 35/42 (83%) | 4 | 411,907 | 109 |
| **fixed `3449d89`** | **41/46 (89%)** | **40/42 (95%)** | **2** | 386,589 | 144 |

gnu.org timed out in 7–8 of its 8 runs under both codes (connection timeouts, one HTTP 429), so the
middle column is the fair comparison. Its one successful run confirms the expected "29 June 2007".

Per site (the independent unit; 10 reachable sites):
- The fix is better on 3: Gutenberg, Packagist, NuGet.
- It is worse on 1: pkg.go.dev.
- The other 6 are the same.
- A 3–1 sign test is not significant (p = 0.63). The false-positive and success numbers point the same
  way, but n is small.

What the runs show:
- **Pre-fix false positives (4), both wrong answers:**
  - Gutenberg "author of the first Moby Dick result" returned the title without the author ×2. This is
    the Hobbit failure again, on a new site.
  - Packagist "description of guzzle" returned feature bullet lines ×2.
  - The fixed code answers both correctly (4/4).
- **Fixed false positives (2), both true but vague:**
  - pkg.go.dev "license of gorilla/mux" returned "BSD licensed. See the LICENSE file for details." (a
    README line) instead of the header's "BSD-3-Clause".
  - The strict scorer counts this as a failure. It is a precision regression from the new line ranking,
    not a wrong answer.
- **Other pre-fix failures:**
  - NuGet "owners" clicked "Contact owners" and landed on a login page ×2.
  - Packagist: a stale-element error ×1.
  - The fixed code passes both tasks.

Cost: 32% more Jev calls (the answer check is a separate small request), 6% fewer input tokens.
The neighbour lines and the rarity ranking give smaller evidence documents.

Remaining: preferring a structured field ("License: BSD-3-Clause") over prose that mentions the same
thing. Measuring that needs another fresh set, because this one has now been seen.

Raw rows: `heldout-fresh-prefix.json`, `heldout-fresh-fixed.json`, `heldout-{test,dev}-fpfix3.json`.
