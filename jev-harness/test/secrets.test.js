import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, secretsFor, STORED } from "../src/secrets.js";

test("secretsFor matches the host and its subdomains only", () => {
  process.env.JEV_SECRETS = JSON.stringify({ "example.com": { username: "u", password: "p" } });
  assert.equal(secretsFor("https://example.com/login").username, "u");
  assert.equal(secretsFor("https://shop.example.com/").password, "p");
  assert.equal(secretsFor("https://notexample.com/"), null);
  assert.equal(secretsFor("about:blank"), null);
});

test("the most specific host entry wins, whatever the file order", () => {
  process.env.JEV_SECRETS = JSON.stringify({ "example.com": { password: "parent" }, "login.example.com": { password: "child" } });
  assert.equal(secretsFor("https://login.example.com/").password, "child");
  assert.equal(secretsFor("https://sso.login.example.com/").password, "child");
  assert.equal(secretsFor("https://shop.example.com/").password, "parent");
});

test("resolve swaps markers for values and leaves other text alone", () => {
  const s = { username: "u", password: "p" };
  assert.equal(resolve(STORED.password, s), "p");
  assert.equal(resolve(STORED.username, s), "u");
  assert.equal(resolve("wireless mouse", s), "wireless mouse");
  assert.equal(resolve(STORED.password, null), "");
});
