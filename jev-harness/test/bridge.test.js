import { test } from "node:test";
import assert from "node:assert/strict";
import { proof } from "../src/browser.js";

test("bridge handshake proofs match the bridge's HMAC format", () => {
  // Vector from bridge.py: hmac.new(b"t", b"client:n", "sha256").hexdigest()
  assert.equal(proof("t", "client", "n"), "2d9cbd306665136d397755ea1ab636bd8fbe50f92f7f28bfb19091c5cd4d4262");
  assert.notEqual(proof("t", "bridge", "n"), proof("t", "client", "n"));
});
