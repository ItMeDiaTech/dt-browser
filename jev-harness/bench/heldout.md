# Held-out evaluation (2026-09-23)

`bench/heldout.js`: 25 WebVoyager-style tasks on 13 real sites that were never used for tuning
(search, multi-level navigation, forms, login, report a value). Expected values were read from the
live pages independently of the harness. The split is **by site** (the unit of independence):
7 dev sites (13 tasks) could be used to choose changes, and 6 test sites (12 tasks) were scored on the
configuration chosen on dev. Success = a verified stop **and** the expected value in the returned evidence
(or the expected URL / page state). 2 reps per task, headed Chrome, memory off. Jev tokens are input tokens.

| run | split | config | success | Jev tokens | calls |
|---|---|---|---:|---:|---:|
| baseline | dev | as tuned on bench/suite.js | 16/26 (62%) | 352,135 | 101 |
| bug fixes | dev | + span punctuation, label/value evidence lines | 20/26 (77%) | 364,325 | 105 |
| threshold | dev | + `OUTCOME_STOP` 0.8 → 0.5 | 22/26 (85%) | 296,987 | 81 |
| **dev-chosen config** | **test** | bug fixes + `OUTCOME_STOP` 0.5 | **15/24 (63%)** | 305,218 | 85 |
| counterfactual | test | bug fixes, `OUTCOME_STOP` 0.8 | 18/24 (75%) | 344,051 | 94 |

For comparison, the tuning suite scores 9/9 (27/27 over 3 reps). **The honest out-of-sample
number is 63%**: that is the configuration chosen on dev, scored once on test. The 75% row used the test
split to reject the threshold change, so it is not out-of-sample.

## What the held-out set changed

- **Kept, 2 bug fixes (found on dev):**
  - `spans()` split tokens on `!`, so "password SuperSecretPassword!" typed `SuperSecretPassword`. The
    run then accepted "Your password is invalid!" as the message. Tokens with inner or trailing
    punctuation are now offered verbatim.
  - Evidence returned `License:` while the value `apache-2.0` sat on the next line. A label line ending
    in `:` now carries the next line.
  - Together: dev 62% → 77%. The tuning suite is unchanged at 9/9.
- **Rejected, `OUTCOME_STOP` 0.8 → 0.5.** On dev it fixed one site: a quotes.toscrape login where
  "Logout" was visible at outcome 0.51–0.59, so the run clicked Logout and looped. On test it broke one
  site: webscraper "Computers → Laptops → first price" stopped at step 0 on the home page with a wrong
  price ($564.98), and the evidence check passed it. One site gained and one lost gives no signal (n=1 site
  each way), and the loss is a wrong answer rather than a stuck run. The threshold stays at 0.8. The other
  per-task difference (openlibrary 2/2 → 1/2) was a `verify_human` bot page, not the threshold.
- **No other threshold change is indicated.**
  - The 0.85 stop, the 0.5/0.3 evidence bars and the 0.1 action floor were not implicated in any
    held-out failure.
  - The 25 inline lines never caused a miss: every miss traced to what was in the document, not to how
    many lines were offered.

## Remaining failures (final config, test split, 6 of 24 runs; not fixed, since fixing them on test data would need a fresh held-out set to measure)

| task | runs failed | cause |
|---|---:|---|
| scrapethissite: capital of Belize | 2/2 | Records span lines ("Belize" / "Capital: Belmopan"). The evidence document keeps goal-matching lines but not their neighbours, so it verified "Capital: Pago Pago". **False positive** |
| openlibrary: The Hobbit's author | 2/2 | `spans()` drops the leading stopword, so it searched "Hobbit" not "The Hobbit". The evidence line is the title without the author (on the next line). **False positive** |
| webscraper: Phones → Touch | 2/2 | The sidebar links carry a generic `aria-label` ("Navigation category"), which wins over the link text, so every category looks alike. It loops |

Dev failures on the final config: arXiv search (the first result is a different paper; the goal needs
the right result opened) and PyPI search (PyPI served a captcha to automation).

The two false positives are the most serious finding: the evidence verifier can confirm a stop from a
line that is on-topic but wrong. Neighbour-line context in the evidence document would address both,
and so would preferring link text over a generic `aria-label`.

Raw rows: `heldout-<split>-<label>.json`.
