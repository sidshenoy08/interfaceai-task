import { test } from "node:test";
import assert from "node:assert/strict";
import { buildParams, resolveValue, InputValidationError } from "./params.js";
import type { CapabilityArtifact } from "../artifact/schema.js";

function artifactWithInputs(inputs: CapabilityArtifact["inputs"]): CapabilityArtifact {
  return {
    id: "test",
    version: 1,
    status: "approved",
    name: "test",
    description: "test",
    target: { app: "test", baseUrl: "http://localhost:4000" },
    riskLevel: "read-only",
    inputs,
    outputs: [],
    steps: [],
    checkpoints: [],
    businessOutcomes: [],
    interstitials: [],
    provenance: { discoveryRunId: "x", model: "x", createdAt: "x" },
  };
}

test("buildParams coerces a declared number input", () => {
  const artifact = artifactWithInputs([{ name: "amount", type: "number", required: true, sensitive: false }]);
  const params = buildParams(artifact, { amount: "42.5" });
  assert.equal(params.amount, 42.5);
});

test("buildParams rejects a non-numeric value for a number input", () => {
  const artifact = artifactWithInputs([{ name: "amount", type: "number", required: true, sensitive: false }]);
  assert.throws(() => buildParams(artifact, { amount: "not-a-number" }), InputValidationError);
});

test("buildParams throws when a required input is missing", () => {
  const artifact = artifactWithInputs([{ name: "memberId", type: "string", required: true, sensitive: false }]);
  assert.throws(() => buildParams(artifact, {}), InputValidationError);
});

test("buildParams allows a missing optional input", () => {
  const artifact = artifactWithInputs([{ name: "notes", type: "string", required: false, sensitive: false }]);
  const params = buildParams(artifact, {});
  assert.equal("notes" in params, false);
});

test("resolveValue returns a literal directly and a param value by lookup", () => {
  assert.equal(resolveValue({ literal: "fixed" }, {}), "fixed");
  assert.equal(resolveValue({ param: "memberId" }, { memberId: "12345" }), "12345");
});

test("resolveValue throws when a referenced param is missing", () => {
  assert.throws(() => resolveValue({ param: "missing" }, {}), InputValidationError);
});
