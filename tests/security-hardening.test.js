import test from "node:test";
import assert from "node:assert/strict";
import { constantTimeEqual, isValidEmail, readJsonLimited } from "../src/security-hardening.js";

test("email validation rejects malformed domains and accepts normal addresses", () => {
  assert.equal(isValidEmail("trader@example.com"), true);
  assert.equal(isValidEmail("trader@sub.example.co.ke"), true);
  assert.equal(isValidEmail("trader@exampleXcom"), false);
  assert.equal(isValidEmail("trader@@example.com"), false);
  assert.equal(isValidEmail("trader@example..com"), false);
});

test("constant-time comparison returns equality without accepting different values", () => {
  assert.equal(constantTimeEqual("same-value", "same-value"), true);
  assert.equal(constantTimeEqual("same-value", "same-valuE"), false);
  assert.equal(constantTimeEqual("short", "longer"), false);
  assert.equal(constantTimeEqual("", ""), true);
});

test("limited JSON reader parses valid JSON and rejects oversized bodies", async () => {
  const valid = new Request("https://example.test", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true })
  });
  assert.deepEqual(await readJsonLimited(valid, 32), { ok: true });

  const tooLarge = new Request("https://example.test", {
    method: "POST", body: JSON.stringify({ value: "x".repeat(100) })
  });
  await assert.rejects(readJsonLimited(tooLarge, 32), error => error.code === "BODY_TOO_LARGE");
});

test("limited JSON reader rejects malformed JSON", async () => {
  const request = new Request("https://example.test", { method: "POST", body: "{" });
  await assert.rejects(readJsonLimited(request));
});
