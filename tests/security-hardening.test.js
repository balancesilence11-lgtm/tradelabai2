import test from "node:test";
import assert from "node:assert/strict";
import {
  constantTimeEqual,
  isValidEmail,
  readJsonLimited
} from "../src/security-hardening.js";

test("email validation accepts normal addresses and rejects malformed domains", () => {
  assert.equal(isValidEmail("trader@example.com"), true);
  assert.equal(isValidEmail("trader@sub.example.co.ke"), true);
  assert.equal(isValidEmail("trader+alerts@example.co.ke"), true);
  assert.equal(isValidEmail("trader@exampleXcom"), false);
  assert.equal(isValidEmail("trader@@example.com"), false);
  assert.equal(isValidEmail("trader@example..com"), false);
  assert.equal(isValidEmail(".trader@example.com"), false);
  assert.equal(isValidEmail("trader@example.com."), false);
  assert.equal(isValidEmail(""), false);
  assert.equal(isValidEmail(null), false);
});

test("constant-time comparison accepts equal values and rejects unequal values", () => {
  assert.equal(constantTimeEqual("same-value", "same-value"), true);
  assert.equal(constantTimeEqual("same-value", "same-valuE"), false);
  assert.equal(constantTimeEqual("short", "longer"), false);
  assert.equal(constantTimeEqual("", ""), true);
  assert.equal(constantTimeEqual(null, ""), true);
});

test("limited JSON reader parses valid JSON within the byte limit", async () => {
  const payload = JSON.stringify({ ok: true });
  const request = new Request("https://example.test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload
  });
  assert.deepEqual(await readJsonLimited(request, new TextEncoder().encode(payload).length), { ok: true });
});

test("limited JSON reader rejects a body that exceeds the streamed byte limit", async () => {
  const request = new Request("https://example.test", {
    method: "POST",
    body: JSON.stringify({ value: "x".repeat(100) })
  });
  await assert.rejects(
    readJsonLimited(request, 32),
    error => error?.code === "BODY_TOO_LARGE"
  );
});

test("limited JSON reader rejects a body declared larger than the byte limit", async () => {
  const request = new Request("https://example.test", {
    method: "POST",
    headers: { "Content-Length": "100" },
    body: "{}"
  });
  await assert.rejects(
    readJsonLimited(request, 32),
    error => error?.code === "BODY_TOO_LARGE"
  );
});

test("limited JSON reader rejects malformed JSON and empty bodies", async () => {
  const malformed = new Request("https://example.test", {
    method: "POST",
    body: "{"
  });
  await assert.rejects(readJsonLimited(malformed), SyntaxError);

  const empty = new Request("https://example.test", { method: "POST" });
  await assert.rejects(readJsonLimited(empty), SyntaxError);
});

test("limited JSON reader rejects invalid UTF-8 instead of silently replacing bytes", async () => {
  const request = new Request("https://example.test", {
    method: "POST",
    body: new Uint8Array([0xff, 0xfe])
  });
  await assert.rejects(readJsonLimited(request), TypeError);
});
