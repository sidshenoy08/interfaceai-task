import { test } from "node:test";
import assert from "node:assert/strict";
import { decideApproval, type StabilityReport } from "./stability.js";
import { meetsApprovalBar, MIN_STABILITY_RUNS } from "./confidence-policy.js";
import type { CapabilityArtifact, StepT } from "../artifact/schema.js";

function artifactWithSteps(steps: StepT[]): CapabilityArtifact {
  return {
    id: "test",
    version: 1,
    status: "draft",
    name: "test",
    description: "test",
    target: { app: "test", baseUrl: "http://localhost:4000" },
    riskLevel: "read-only",
    inputs: [],
    outputs: [],
    steps,
    checkpoints: [],
    businessOutcomes: [],
    interstitials: [],
    provenance: { discoveryRunId: "x", model: "x", createdAt: "x" },
  };
}

const readOnlyStep: StepT = { index: 0, action: "navigate", description: "go", risk: "read-only", requiresConfirmation: false };
const irreversibleStep: StepT = { index: 0, action: "click", description: "submit", risk: "irreversible", requiresConfirmation: true };

function report(overrides: Partial<StabilityReport>): StabilityReport {
  return { runs: MIN_STABILITY_RUNS, successes: MIN_STABILITY_RUNS, score: 1, results: [], evidenceDir: "x", ...overrides };
}

test("decideApproval approves a read-only artifact that meets the reliability bar", () => {
  const decision = decideApproval(artifactWithSteps([readOnlyStep]), report({}));
  assert.equal(decision.status, "approved");
});

test("decideApproval keeps a below-bar artifact in draft", () => {
  const decision = decideApproval(artifactWithSteps([readOnlyStep]), report({ successes: MIN_STABILITY_RUNS - 1, score: (MIN_STABILITY_RUNS - 1) / MIN_STABILITY_RUNS }));
  assert.equal(decision.status, "draft");
});

test("decideApproval never auto-approves an artifact with an irreversible step, even at a perfect score", () => {
  const decision = decideApproval(artifactWithSteps([irreversibleStep]), report({}));
  assert.equal(decision.status, "draft");
  assert.match(decision.reason, /irreversible/);
});

test("decideApproval requires the minimum run count, not just a perfect score", () => {
  const decision = decideApproval(artifactWithSteps([readOnlyStep]), report({ runs: 1, successes: 1, score: 1 }));
  assert.equal(decision.status, "draft");
});

test("meetsApprovalBar defaults to true for an artifact that was never stability-tested", () => {
  assert.equal(meetsApprovalBar(undefined), true);
});

test("meetsApprovalBar is false below the score or run-count threshold", () => {
  assert.equal(meetsApprovalBar({ score: 0.9, runs: MIN_STABILITY_RUNS }), false);
  assert.equal(meetsApprovalBar({ score: 1, runs: MIN_STABILITY_RUNS - 1 }), false);
  assert.equal(meetsApprovalBar({ score: 1, runs: MIN_STABILITY_RUNS }), true);
});
