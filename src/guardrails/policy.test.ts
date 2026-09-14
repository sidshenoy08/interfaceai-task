import { test } from "node:test";
import assert from "node:assert/strict";
import { PolicyEngine } from "./policy.js";

const config = {
  allowedOrigins: ["http://localhost:4000"],
  allowedActions: ["navigate", "click", "type", "select", "extract_text"],
  sensitiveFieldNames: ["ssn", "password"],
  irreversibleHints: ["confirm and open account", "delete"],
};

test("checkOrigin allows only configured origins", () => {
  const policy = new PolicyEngine(config);
  assert.equal(policy.checkOrigin("http://localhost:4000/members/1").allowed, true);
  assert.equal(policy.checkOrigin("http://evil.example.com/members/1").allowed, false);
});

test("effectiveRisk escalates on an exact irreversible-action phrase, not a substring of it", () => {
  const policy = new PolicyEngine(config);
  assert.equal(policy.effectiveRisk("read-only", "Confirm and Open Account"), "irreversible");
  // "confirmation screen" contains "confirm" but not the full hint phrase — must NOT escalate.
  assert.equal(policy.effectiveRisk("read-only", "Continue to confirmation screen"), "read-only");
});

test("requiresConfirmation blocks an irreversible action until confirmed, then allows it", () => {
  const policy = new PolicyEngine(config);
  const key = "confirm and open account";
  assert.equal(policy.requiresConfirmation("irreversible", key).allowed, false);
  policy.recordConfirmation(key);
  assert.equal(policy.requiresConfirmation("irreversible", key).allowed, true);
});

test("requiresConfirmation never blocks read-only or reversible actions", () => {
  const policy = new PolicyEngine(config);
  assert.equal(policy.requiresConfirmation("read-only", "anything").allowed, true);
  assert.equal(policy.requiresConfirmation("reversible", "anything").allowed, true);
});

test("isSensitiveField matches configured field-name substrings case-insensitively", () => {
  const policy = new PolicyEngine(config);
  assert.equal(policy.isSensitiveField("SSN"), true);
  assert.equal(policy.isSensitiveField("memberId"), false);
});
