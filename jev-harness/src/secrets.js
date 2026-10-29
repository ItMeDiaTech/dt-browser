// Origin-scoped credentials (the jkudish/fastbrowse pattern). Jev only ever sees that a stored
// username/password exists for the site; the values are typed by code, redacted in snapshots, and
// recorded in history and plans as these markers, never as text.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const STORED = { username: "(stored username)", password: "(stored password)" };

function load() {
  if (process.env.JEV_SECRETS) { try { return JSON.parse(process.env.JEV_SECRETS); } catch { return {}; } }
  try { return JSON.parse(readFileSync(join(process.env.JEV_HOME || join(homedir(), ".jev-harness"), "secrets.json"), "utf8")); } catch { return {}; }
}

/** Credentials for the page's host: `{ "www.example.com": { "username": "...", "password": "..." } }`. */
export function secretsFor(url) {
  let host; try { host = new URL(url).hostname; } catch { return null; }
  const all = load();
  // The most specific entry wins: login.example.com's credential over example.com's, whatever the file order.
  const key = Object.keys(all).filter((k) => host === k || host.endsWith(`.${k}`)).sort((a, b) => b.length - a.length)[0];
  return key ? all[key] : null;
}

/** Replace a marker with the real value at the moment of typing; anything else passes through. */
export function resolve(text, secrets) {
  if (text === STORED.password) return secrets?.password ?? "";
  if (text === STORED.username) return secrets?.username ?? "";
  return text;
}
