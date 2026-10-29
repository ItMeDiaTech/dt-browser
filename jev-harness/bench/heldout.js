// Held-out task set (WebVoyager-style: real sites, search / navigate / form / report). None of these
// sites was used when the thresholds (0.85 stop, 0.5/0.3 evidence bars, 0.1 action floor, 25 inline
// lines) were tuned on bench/suite.js. Split by SITE, the unit of independence: `dev` sites may be
// used to choose a threshold change; `test` sites are scored once, on the final configuration.
// Expected values were read from the live pages independently of the harness (2026-09-23).
// Run:  JEV_NO_MEMORY=1 node bench/heldout.js <dev|test> [label] [reps]   -> bench/heldout-<split>-<label>.json
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runTask } from "./runner.js";

export const TASKS = [
  // ---- dev ----
  { split: "dev", site: "quotes", url: "https://quotes.toscrape.com/", goal: "Open the tag love and report the author of the first quote listed.", expect: /Gide/ },
  { split: "dev", site: "quotes", url: "https://quotes.toscrape.com/", goal: "Go to the login page, log in with username ada and password lovelace, and report the link that replaced Login.", expect: /Logout/ },
  { split: "dev", site: "arxiv", url: "https://arxiv.org/", goal: "Search arXiv for Attention Is All You Need and report the year the paper was first submitted.", expect: /2017/ },
  { split: "dev", site: "arxiv", url: "https://arxiv.org/abs/1706.03762", goal: "Report the first author of this paper.", expect: /Vaswani/ },
  { split: "dev", site: "pypi", url: "https://pypi.org/", goal: "Search PyPI for flask, open the Flask package page and report its summary.", expect: /simple framework for building complex web applications/i },
  { split: "dev", site: "pypi", url: "https://pypi.org/project/Flask/", goal: "Report the minimum Python version this package requires.", expect: />=\s?3\.9/ },
  { split: "dev", site: "pydocs", url: "https://docs.python.org/3/", goal: "Open the tutorial and report the title of section 4.", expect: /More Control Flow Tools/ },
  { split: "dev", site: "pydocs", url: "https://docs.python.org/3/", goal: "Search the documentation for itertools.groupby and open the itertools module page.", expect: null, expectUrl: /library\/itertools\.html/ },
  { split: "dev", site: "the-internet", url: "https://the-internet.herokuapp.com/login", goal: "Log in with username tomsmith and password SuperSecretPassword! and report the message shown.", expect: /logged into a secure area/ },
  { split: "dev", site: "the-internet", url: "https://the-internet.herokuapp.com/dropdown", goal: "Select Option 2 in the dropdown list.", expect: null, check: "document.querySelector('#dropdown').selectedOptions[0].text === 'Option 2'" },
  { split: "dev", site: "huggingface", url: "https://huggingface.co/", goal: "Search for the model bert-base-uncased, open it and report its license.", expect: /apache-2\.0/i },
  { split: "dev", site: "huggingface", url: "https://huggingface.co/datasets/stanfordnlp/imdb", goal: "Report how many rows the test split has.", expect: /25(,|\.)?0{3}|25k/i },
  { split: "dev", site: "selenium", url: "https://www.selenium.dev/selenium/web/web-form.html", goal: "Type hello jev into the text input and submit the form.", expect: /Received/ },
  // ---- test ----
  { split: "test", site: "scrapethissite", url: "https://www.scrapethissite.com/pages/forms/", goal: "Search for Boston Bruins and report how many games they won in 1990.", expect: /\b44\b/ },
  { split: "test", site: "scrapethissite", url: "https://www.scrapethissite.com/pages/simple/", goal: "Report the capital of Belize.", expect: /Belmopan/ },
  { split: "test", site: "github", url: "https://github.com/pallets/flask", goal: "Report the license of this repository.", expect: /BSD-3-Clause/i },
  { split: "test", site: "github", url: "https://github.com/pallets/flask", goal: "Open the Issues tab of this repository.", expect: null, expectUrl: /pallets\/flask\/issues/ },
  { split: "test", site: "mdn", url: "https://developer.mozilla.org/en-US/", goal: "Search MDN for Array.prototype.flat and report the default depth.", expect: /Defaults to 1/ },
  { split: "test", site: "mdn", url: "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements", goal: "Open the page for the dialog element and report what it represents.", expect: /modal or non-modal dialog box/ },
  { split: "test", site: "openlibrary", url: "https://openlibrary.org/", goal: "Search Open Library for The Hobbit and report the author of the first result.", expect: /Tolkien/ },
  { split: "test", site: "openlibrary", url: "https://openlibrary.org/", goal: "Search for the author Octavia Butler, open her author page and report her birth date.", expect: /1947/ },
  { split: "test", site: "webscraper", url: "https://webscraper.io/test-sites/e-commerce/allinone", goal: "Open the Computers category, then Laptops, and report the price of the first laptop.", expect: /295\.99/ },
  { split: "test", site: "webscraper", url: "https://webscraper.io/test-sites/e-commerce/allinone", goal: "Open the Phones category, then Touch, and report the name of the first phone listed.", expect: /Nokia 123/ },
  { split: "test", site: "demoqa", url: "https://demoqa.com/text-box", goal: "Fill the form with full name Ada Lovelace and email ada@example.com, then submit it.", expect: /Name:\s?Ada Lovelace/ },
  { split: "test", site: "demoqa", url: "https://demoqa.com/radio-button", goal: "Select the Impressive radio button.", expect: /You have selected Impressive/ },
  // ---- fresh (2026-09-23, second set) ----
  // Built after the dev/test sets were used to develop the false-positive fix: sites never touched by
  // any tuning, with extra table/record lookups (where the false "done" answers came from). Scored
  // once for the pre-fix and the fixed code; nothing was changed after seeing the results.
  { split: "fresh", site: "gutenberg", url: "https://www.gutenberg.org/", goal: "Search Project Gutenberg for Moby Dick and report the author of the first result.", expect: /Melville/ },
  { split: "fresh", site: "gutenberg", url: "https://www.gutenberg.org/ebooks/1342", goal: "Report the release date of this eBook.", expect: /Jun(e)? 1, 1998/ },
  { split: "fresh", site: "pkg.go.dev", url: "https://pkg.go.dev/", goal: "Search for github.com/gorilla/mux, open the package and report its license.", expect: /BSD-3-Clause/ },
  { split: "fresh", site: "pkg.go.dev", url: "https://pkg.go.dev/github.com/google/uuid", goal: "Report the license of this package.", expect: /BSD-3-Clause/ },
  { split: "fresh", site: "rubygems", url: "https://rubygems.org/", goal: "Search for rails, open the rails gem page and report its license.", expect: /\bMIT\b/ },
  { split: "fresh", site: "rubygems", url: "https://rubygems.org/gems/nokogiri", goal: "Report the license of this gem.", expect: /\bMIT\b/ },
  { split: "fresh", site: "packagist", url: "https://packagist.org/", goal: "Search for monolog, open monolog/monolog and report its license.", expect: /\bMIT\b/ },
  { split: "fresh", site: "packagist", url: "https://packagist.org/packages/guzzlehttp/guzzle", goal: "Report the description of this package.", expect: /PHP HTTP client/ },
  { split: "fresh", site: "nuget", url: "https://www.nuget.org/", goal: "Search for Newtonsoft.Json, open the package and report its license.", expect: /\bMIT\b/ },
  { split: "fresh", site: "nuget", url: "https://www.nuget.org/packages/Newtonsoft.Json", goal: "Report the owners of this package.", expect: /jamesnk|newtonsoft/i },
  { split: "fresh", site: "iana", url: "https://www.iana.org/domains/root/db", goal: "Report the TLD manager of the .museum domain.", expect: /Museum Domain Management Association/ },
  { split: "fresh", site: "iana", url: "https://www.iana.org/domains/root/db", goal: "Report the TLD manager of the .coop domain.", expect: /DotCooperation/ },
  { split: "fresh", site: "rsc", url: "https://periodic-table.rsc.org/", goal: "Open the element iron and report its melting point.", expect: /1538/ },
  { split: "fresh", site: "rsc", url: "https://periodic-table.rsc.org/element/79/gold", goal: "Report the group of this element.", expect: /\b11\b/ },
  { split: "fresh", site: "w3schools", url: "https://www.w3schools.com/tags/", goal: "Open the page for the abbr tag and report what it defines.", expect: /abbreviation or an acronym/ },
  { split: "fresh", site: "w3schools", url: "https://www.w3schools.com/sql/", goal: "Open the SQL SELECT DISTINCT page and report what the statement is used for.", expect: /distinct \(unique\) values|only distinct/i },
  { split: "fresh", site: "expandtesting", url: "https://practice.expandtesting.com/tables", goal: "Report the email address of Jason Doe in the first table.", expect: /jdoe@hotmail\.com/ },
  { split: "fresh", site: "expandtesting", url: "https://practice.expandtesting.com/tables", goal: "Report how much Frank Bach owes.", expect: /\$?51\.00/ },
  { split: "fresh", site: "expandtesting", url: "https://practice.expandtesting.com/login", goal: "Log in with username practice and password SuperSecretPassword! and report the message shown.", expect: /logged into a secure area/ },
  { split: "fresh", site: "crates.io", url: "https://crates.io/", goal: "Search crates.io for serde, open the serde crate and report its license.", expect: /MIT OR Apache-2\.0/ },
  { split: "fresh", site: "crates.io", url: "https://crates.io/crates/tokio", goal: "Report the license of this crate.", expect: /\bMIT\b/ },
  { split: "fresh", site: "gnu", url: "https://www.gnu.org/licenses/gpl-3.0.html", goal: "Report the date this version of the license was published.", expect: /29 June 2007/ },
  { split: "fresh", site: "gnu", url: "https://www.gnu.org/licenses/", goal: "Open the HTML version of the GNU Lesser General Public License and report its version number.", expect: /Version 3/ },
  // ---- fresh3 (2026-09-23, third set) ----
  // For the labelled-field preference: metadata pages where a field ("License: perl_5") and prose
  // about the same thing both exist. Expected values are the field's exact value (strict), fixed before
  // any run; docs.rs has only a "License" heading followed by prose (stress case for the field rule).
  { split: "fresh3", site: "hex.pm", url: "https://hex.pm/", goal: "Search for phoenix, open the phoenix package and report its license.", expect: /\bMIT\b/ },
  { split: "fresh3", site: "hex.pm", url: "https://hex.pm/packages/jason", goal: "Report the license of this package.", expect: /Apache-2\.0/ },
  { split: "fresh3", site: "pub.dev", url: "https://pub.dev/", goal: "Search for http, open the http package and report its license.", expect: /BSD-3-Clause/ },
  { split: "fresh3", site: "pub.dev", url: "https://pub.dev/packages/provider", goal: "Report the license of this package.", expect: /\bMIT\b/ },
  { split: "fresh3", site: "pub.dev", url: "https://pub.dev/packages/provider", goal: "Report the publisher of this package.", expect: /dash-overflow\.net/ },
  { split: "fresh3", site: "brew", url: "https://formulae.brew.sh/formula/wget", goal: "Report the license of this formula.", expect: /GPL-3\.0-or-later/ },
  { split: "fresh3", site: "brew", url: "https://formulae.brew.sh/formula/jq", goal: "Report the homepage of this formula.", expect: /jqlang\.github\.io\/jq/ },
  { split: "fresh3", site: "brew", url: "https://formulae.brew.sh/", goal: "Search for jq, open the jq formula and report its license.", expect: /\bMIT\b/ },
  { split: "fresh3", site: "cran", url: "https://cran.r-project.org/web/packages/dplyr/index.html", goal: "Report the license of this package.", expect: /MIT \+ file LICENSE/ },
  { split: "fresh3", site: "cran", url: "https://cran.r-project.org/web/packages/dplyr/index.html", goal: "Report the maintainer of this package.", expect: /Hadley Wickham/ },
  { split: "fresh3", site: "cran", url: "https://cran.r-project.org/web/packages/ggplot2/index.html", goal: "Report the maintainer of this package.", expect: /Thomas Lin Pedersen/ },
  { split: "fresh3", site: "docs.rs", url: "https://docs.rs/crate/regex/latest", goal: "Report the license of this crate.", expect: /MIT[\s\S]*Apache|Apache[\s\S]*MIT/ },
  { split: "fresh3", site: "docs.rs", url: "https://docs.rs/crate/rand/latest", goal: "Report the license of this crate.", expect: /MIT[\s\S]*Apache|Apache[\s\S]*MIT/ },
  { split: "fresh3", site: "f-droid", url: "https://f-droid.org/en/packages/org.fdroid.fdroid/", goal: "Report the license of this app.", expect: /v3\.0 or later|GPL-3\.0-or-later/ },
  { split: "fresh3", site: "f-droid", url: "https://f-droid.org/en/packages/org.videolan.vlc/", goal: "Report the license of this app.", expect: /v3\.0 only|GPL-3\.0-only/ },
  { split: "fresh3", site: "metacpan", url: "https://metacpan.org/pod/Moose", goal: "Report the license of this distribution.", expect: /perl_5/ },
  { split: "fresh3", site: "metacpan", url: "https://metacpan.org/", goal: "Search for Moose, open the Moose module and report its license.", expect: /perl_5/ },
  { split: "fresh3", site: "wikidata", url: "https://www.wikidata.org/wiki/Q42", goal: "Report the date of birth of this person.", expect: /11 March 1952/ },
  { split: "fresh3", site: "wikidata", url: "https://www.wikidata.org/wiki/Q42", goal: "Report the place of birth of this person.", expect: /Cambridge/ },
  { split: "fresh3", site: "wikidata", url: "https://www.wikidata.org/wiki/Q42", goal: "Report the date of death of this person.", expect: /11 May 2001/ },
  { split: "fresh3", site: "wikidata", url: "https://www.wikidata.org/", goal: "Search for Ada Lovelace, open her item and report her date of birth.", expect: /10 December 1815/ },
];

// Success = a verified stop AND the expected value in the returned evidence (or URL / page check):
// a run that reaches the right page but does not return the answer does not count.
async function score(t, r, tab) {
  if (!["done", "goal_achieved"].includes(r.status)) return false;
  if (t.expect && !t.expect.test(JSON.stringify(r.evidence))) return false;
  if (t.expectUrl && !t.expectUrl.test(r.url || "")) return false;
  if (t.check) return (await tab.evaluate(t.check).catch(() => false)) === true;
  return true;
}

// An uncaught error once ended a run with no stack in the log (2026-09-23, not reproduced in 3 more
// runs): record it with its stack so the next occurrence can be traced.
// Importable (bench/soak.js reuses TASKS): only run when executed directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

async function main() {
  for (const ev of ["uncaughtException", "unhandledRejection"]) process.on(ev, (e) => { console.error(`UNCAUGHT ${ev}: ${e?.stack || e}`); process.exitCode = 1; });
  const [split = "dev", label = "run", reps = "2"] = process.argv.slice(2);
  const rows = [];
  for (let rep = 0; rep < Number(reps); rep++) {
    for (const t of TASKS.filter((x) => x.split === split)) {
      const { r, ok } = await runTask(t, { maxSteps: 15, score });
      const row = { site: t.site, goal: t.goal, rep, status: r.status, success: ok, steps: r.steps?.length ?? 0, jev_calls: r.jev.calls,
        jev_tokens: r.jev.input_tokens, ms: r.elapsed_ms, url: r.url, stepsTaken: r.steps, notes: r.notes, evidence: r.evidence?.lines?.slice(0, 2) };
      rows.push(row);
      console.error(`${split}#${rep} ${t.site}: ${row.status} ok=${ok} steps=${row.steps} jev=${row.jev_tokens}tok/${row.jev_calls}calls ${row.ms}ms`);
    }
  }
  writeFileSync(new URL(`./heldout-${split}-${label}.json`, import.meta.url), JSON.stringify({ split, label, date: new Date().toISOString(), rows }, null, 1));
  const n = rows.length, k = rows.filter((r) => r.success).length;
  // Sites, not rows, are independent: report per-site success too.
  const sites = [...new Set(rows.map((r) => r.site))].map((s) => { const rs = rows.filter((r) => r.site === s); return `${s} ${rs.filter((r) => r.success).length}/${rs.length}`; });
  // A false positive is the worst outcome: a verified stop whose answer is wrong.
  const fp = rows.filter((r) => ["done", "goal_achieved"].includes(r.status) && !r.success).length;
  console.log(`${split} ${label}: ${k}/${n} runs succeeded (${(100 * k / n).toFixed(0)}%), ${fp} false-positive stops, ${rows.reduce((s, r) => s + r.jev_tokens, 0).toLocaleString()} Jev tokens, ${rows.reduce((s, r) => s + r.jev_calls, 0)} calls\nper site: ${sites.join(", ")}`);
  process.exit(0);
}
