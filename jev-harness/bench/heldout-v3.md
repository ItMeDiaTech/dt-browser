# Labelled field over prose: fix and third fresh held-out check (2026-09-23)

## The problem

On the second fresh set (bench/heldout-v2.md), pkg.go.dev "report its license" returned the README
sentence "BSD licensed. See the LICENSE file for details." instead of the page's `License: BSD-3-Clause`.
Measured on the live page:
- **Relevance bug.** Stopwords counted. "for" and "the" from "Search **for** … open **the** package"
  gave the README line 10.52 against 5.96 for the field line.
- **Jev's choice.** Even with the field line in the document, Jev put p=1 on the prose line.

## The changes (`src/jev.js`, `src/engine.js`)

1. **Stopword-free relevance.** The words of the existing stopword list no longer score. After this
   change alone, Jev picked `License: BSD-3-Clause` itself (p=0.99).
2. **Labelled-field backstop (`preferField`).** Code parses the attribute the goal asks for ("report its
   license" → `license`). If the page has exactly one field for it (`License: X`, or a `License` line
   followed by its value), that field goes first in the evidence. A label that repeats with different
   values (250 × "Capital: …") belongs to many records, so the choice stays with Jev.
3. **"Open …" goals must navigate before stopping.** Change 1 moved MDN's element index into the step
   window. A run then stopped at step 0 on the index ("Represents a dialog box…"), which answers only
   half of "**open** the page for the dialog element and report …". A stop vote before any navigation
   is now vetoed for goals that say open / go to / navigate to.

Development data (all previously seen sets, 2 reps; old test 20/24 → 22/24 once change 3 went in):

| set | before (`f4189bd`) | after | false-positive stops |
|---|---:|---:|---|
| 2nd fresh (now dev) | 41/46 | 40/46 | 2 → 0 (pkg.go.dev 2/4 → 4/4) |
| old test | 22/24 | 22/24 | 0 → 0 |
| old dev | 20/26 | 19/26 | 0 → 0 |
| tuning suite | 9/9 | 9/9 | — |
| real sites | 5/5 | 5/5 | books-title now opens the book (1 step instead of 0) |

The small drops are one-off navigation loops on tasks that pass in other runs: expandtesting clicked
"Home", huggingface searched again, and Packagist hit a stale element. None of them is a wrong answer.

## Third fresh held-out set (`split: "fresh3"`)

- **Tasks:** 22 on 8 new sites: hex.pm, pub.dev, Homebrew formulae, CRAN, docs.rs, F-Droid, MetaCPAN
  and Wikidata. They are metadata pages where a field and prose about the same thing both exist.
- **Expected values:** the field's exact value (strict), read from the live pages and fixed before any
  run. npm was dropped because it served a Cloudflare challenge.
- **Stress case:** docs.rs has only a "License" heading followed by prose.
- **Runs:** before (`f4189bd`) and after (`93db55f`), 2 reps each, memory off, nothing changed after
  seeing results.

| code | success | false-positive stops | Jev tokens | calls |
|---|---:|---:|---:|---:|
| before | 36/42 (86%) | 2 | 358,473 | 131 |
| **after** | **38/42 (90%)** | **0** | 309,491 | 120 |

- **The one difference** is the target case. hex.pm "license of jason" returned "Jason is released
  under the Apache License 2.0" (prose) in 2/2 runs before, and "Apache-2.0" (the field) in 2/2 after.
- **Failures common to both codes (4 runs):**
  - Homebrew's search is a JavaScript overlay the run never gets into (2).
  - MetaCPAN's search served a captcha (2).
- **Attribution:**
  - The code-side field rule fired in **0** of the 42 fresh runs, and in 7 of 96 development runs.
    The fresh-set gain came from the stopword-free relevance: with a cleaner evidence document, Jev
    picks the field itself.
  - The field rule is a backstop, not the main effect.
  - docs.rs's heading-then-prose layout never triggered it; Jev returned the prose, which is the only
    statement of the license there, and it passed.
- **Confidence:** n is small. One site changed (hex.pm) and one false-positive pair was removed; the
  direction matches the development data.

Raw rows: `heldout-fresh3-{before,after}.json`, `heldout-{fresh,test,dev}-field2.json`.
