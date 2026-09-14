// Shared confidence/approval thresholds. Split into their own module so that
// replay/executor.ts (which enforces the approval gate) and replay/stability.ts
// (which produces the evidence the gate reads) can both depend on the same
// numbers without executor.ts having to import stability.ts, which itself
// imports executor.ts (to actually run the replays it's measuring).
export const STABILITY_APPROVAL_THRESHOLD = 1.0; // every sampled run must behave correctly (success or a declared business outcome)
export const MIN_STABILITY_RUNS = 3; // one lucky run isn't evidence of reliability

/**
 * Whether an artifact's recorded confidence evidence (if any) clears the bar
 * for unattended replay. An artifact that has never been stability-tested
 * returns true here deliberately — this policy only tightens the gate once
 * real evidence of instability exists, it doesn't retroactively block every
 * artifact that predates this feature.
 */
export function meetsApprovalBar(confidence: { score: number; runs: number } | undefined): boolean {
  if (!confidence) return true;
  return confidence.score >= STABILITY_APPROVAL_THRESHOLD && confidence.runs >= MIN_STABILITY_RUNS;
}
