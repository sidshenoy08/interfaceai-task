// The Capability Artifact schema: the reusable, agent-invocable contract
// produced by a discovery run and consumed by the replay engine.
//
// Design intent (see /REPORT.md section 2 for the full rationale):
//  - It is decoupled from the raw model transcript: steps carry a locator
//    fallback chain and a human-readable rationale, not "the LLM said to
//    click at (x, y)".
//  - Business outcomes and interstitials are declared as first-class,
//    named conditions rather than being folded into generic step failures.
//  - Risk is a property of the artifact and of individual steps, so replay
//    can gate irreversible capabilities without extra machinery.
import { z } from "zod";

export const LocatorStrategySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("role"), role: z.string(), name: z.string(), nth: z.number().optional() }),
  z.object({ kind: z.literal("css"), value: z.string() }),
  z.object({ kind: z.literal("text"), value: z.string() }),
  z.object({ kind: z.literal("tableCell"), rowLabel: z.string(), columnIndex: z.number() }),
]);
export type LocatorStrategyT = z.infer<typeof LocatorStrategySchema>;

export const LocatorSpecSchema = z.object({
  strategies: z.array(LocatorStrategySchema).min(1),
});

// A step value can be a literal string or a reference to a named input
// parameter, resolved at replay time. Keeping this explicit (rather than
// string templating) is what lets us tell, just from the artifact, exactly
// which literal values were baked in during discovery vs. which are
// caller-supplied per invocation.
export const ValueRefSchema = z.union([
  z.object({ literal: z.string() }),
  z.object({ param: z.string() }),
]);
export type ValueRefT = z.infer<typeof ValueRefSchema>;

export const DetectConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("urlContains"), value: z.string() }),
  z.object({ kind: z.literal("textPresent"), value: z.string() }),
  z.object({ kind: z.literal("textAbsent"), value: z.string() }),
  z.object({ kind: z.literal("elementVisible"), target: LocatorSpecSchema }),
]);
export type DetectConditionT = z.infer<typeof DetectConditionSchema>;

export const StepActionSchema = z.enum(["navigate", "click", "type", "select", "extract_text"]);
export type StepActionT = z.infer<typeof StepActionSchema>;

export const RiskLevelSchema = z.enum(["read-only", "reversible", "irreversible"]);
export type RiskLevelT = z.infer<typeof RiskLevelSchema>;

export const StepSchema = z.object({
  index: z.number(),
  action: StepActionSchema,
  description: z.string(),
  target: LocatorSpecSchema.optional(),
  url: ValueRefSchema.optional(),
  value: ValueRefSchema.optional(),
  extractAs: z.string().optional(),
  risk: RiskLevelSchema.default("read-only"),
  requiresConfirmation: z.boolean().default(false),
});
export type StepT = z.infer<typeof StepSchema>;

export const CheckpointSchema = z.object({
  afterStep: z.number(),
  description: z.string(),
  assert: DetectConditionSchema,
  onFail: z.enum(["retry", "escalate", "fail"]).default("escalate"),
  retry: z.object({ attempts: z.number(), delayMs: z.number() }).optional(),
});
export type CheckpointT = z.infer<typeof CheckpointSchema>;

export const BusinessOutcomeSchema = z.object({
  name: z.string(),
  description: z.string(),
  detect: DetectConditionSchema,
});
export type BusinessOutcomeT = z.infer<typeof BusinessOutcomeSchema>;

export const InterstitialSchema = z.object({
  name: z.string(),
  description: z.string(),
  detect: DetectConditionSchema,
  dismiss: z.object({
    action: z.literal("click"),
    target: LocatorSpecSchema,
  }),
});
export type InterstitialT = z.infer<typeof InterstitialSchema>;

export const FieldSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().optional(),
  required: z.boolean().default(true),
  sensitive: z.boolean().default(false),
});
export type FieldT = z.infer<typeof FieldSchema>;

// Evidence from a multi-run stability check (src/replay/stability.ts,
// optional stretch goal — see /REPORT.md "Confidence & approval"): the same
// artifact replayed with the same inputs, N times, with no LLM involved and
// nothing about the artifact changing between runs. Because the target UI is
// stable by the brief's own premise, a run that doesn't succeed isn't a
// logic bug in the recording — it's exactly the kind of transient runtime
// flakiness (a slow load racing a fixed timeout, a race on a rendered
// element) that's otherwise invisible until a caller hits it in production.
export const ConfidenceSchema = z.object({
  score: z.number().min(0).max(1),
  runs: z.number(),
  successes: z.number(),
  evaluatedAt: z.string(),
  evaluatedWithInputs: z.record(z.string(), z.string()),
  evidenceDir: z.string(),
});
export type ConfidenceT = z.infer<typeof ConfidenceSchema>;

export const CapabilityArtifactSchema = z.object({
  id: z.string(),
  version: z.number(),
  status: z.enum(["draft", "approved"]).default("draft"),
  name: z.string(),
  description: z.string(),
  target: z.object({
    app: z.string(),
    baseUrl: z.string(),
  }),
  riskLevel: z.enum(["read-only", "reversible-write", "irreversible-write"]),
  inputs: z.array(FieldSchema),
  outputs: z.array(FieldSchema),
  steps: z.array(StepSchema),
  checkpoints: z.array(CheckpointSchema),
  businessOutcomes: z.array(BusinessOutcomeSchema),
  interstitials: z.array(InterstitialSchema),
  confidence: ConfidenceSchema.optional(),
  provenance: z.object({
    discoveryRunId: z.string(),
    model: z.string(),
    createdAt: z.string(),
  }),
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;
