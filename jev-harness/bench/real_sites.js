// Real e-commerce pages (read-only goals; add-to-cart only on demo stores). Reports how many raw
// elements each page had versus the 60-element pruning budget.  JEV_NO_MEMORY=1 JEV_HEADLESS=1 node bench/real_sites.js
import { runTask } from "./runner.js";

const TASKS = [
  { id: "books-category", url: "https://books.toscrape.com/", goal: "Open the Travel category and report the price of the first book listed.", expect: "£" },
  { id: "books-title", url: "https://books.toscrape.com/", goal: "Open the book A Light in the Attic and report its price.", expect: "51.77" },
  { id: "demoblaze", url: "https://www.demoblaze.com/", goal: "Open the Monitors category, open the ASUS Full HD monitor and report its price.", expect: "230" },
  { id: "autoexercise", url: "https://automationexercise.com/products", goal: "Search for dress and report the name of the first product shown.", expect: "Dress", expectUrl: "search=dress" },
  { id: "ebay", url: "https://www.ebay.com/", goal: "Search eBay for logitech m185 and report the price of the first listing.", expect: "$" },
];
const rows = [];
for (const t of TASKS) {
  const { r, ok } = await runTask(t, { maxSteps: 12 });
  rows.push(`| ${t.id} | ${r.status} | ${ok ? "yes" : "NO"} | ${r.steps?.length ?? 0} | ${r.jev.calls} | ${r.jev.input_tokens?.toLocaleString()} | ${r.jev.elements_max} | ${r.elapsed_ms} |`);
  console.error(JSON.stringify({ id: t.id, status: r.status, ok, steps: r.steps, evidence: r.evidence?.lines?.slice(0, 2), notes: r.notes }, null, 1));
}
console.log("| site | status | ok | steps | Jev calls | Jev tokens | raw elements (max) | ms |\n|---|---|---|---:|---:|---:|---:|---:|\n" + rows.join("\n"));
