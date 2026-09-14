import { test } from "node:test";
import assert from "node:assert/strict";
import { redactText, redactFieldValue } from "./redaction.js";

test("redactText masks SSN-shaped and email-shaped substrings", () => {
  const out = redactText("Member SSN is 123-45-6789, contact jane@example.com");
  assert.ok(!out.includes("123-45-6789"));
  assert.ok(!out.includes("jane@example.com"));
  assert.ok(out.includes("[REDACTED:ssn]"));
  assert.ok(out.includes("[REDACTED:email]"));
});

test("redactFieldValue fully masks a value whose field name matches a sensitive pattern", () => {
  assert.equal(redactFieldValue("password", "hunter2", ["password", "ssn"]), "[REDACTED]");
});

test("redactFieldValue leaves a non-sensitive field's value as-is (still pattern-redacted)", () => {
  assert.equal(redactFieldValue("memberId", "12345", ["password", "ssn"]), "12345");
});
