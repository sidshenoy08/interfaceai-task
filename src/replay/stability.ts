// Multi-run stability check (optional stretch goal — see /REPORT.md,
// "Confidence & approval"). The brief's own premise (Section 1) is that
// these UIs are stable; the interesting failures are runtime conditions, not
// layout drift. That means replaying the SAME artifact with the SAME inputs
// N times, with nothing about the artifact or the target changing between
// runs, should in principle produce the same outcome every time. Where it
// doesn't, the difference isn't a logic bug in the recording — it's exactly
// the kind of transient flakiness (a slow load racing a fixed timeout, an
// element that hasn't finished rendering yet) that's otherwise invisible
// until a caller hits it, once, in production. Running the replay N times
// and reporting the success rate turns that into a first-class signal
// attached to the artifact instead.
import type { CapabilityArtifact } from "../artifact/schema.js";
import { replayArtifact, type ReplayOptions } from "./executor.js";
import { EvidenceLogger, newRunId } from "../evidence/logger.js";
import { STABILITY_APPROVAL_THRESHOLD, MIN_STABILITY_RUNS } from "./confidence-policy.js";

export interface StabilityRunResult {
  runId: string;
  status: "success" | "business_outcome" | "error";
  detail: string;
  evidenceDir: string;
}

export interface StabilityReport {
  runs: number;
  successes: number;
  score: number;
  results: StabilityRunResult[];
  evidenceDir: string;
}

export interface ApprovalDecision {
  status: "draft" | "approved";
  reason: string;
}

export async function runStabilityCheck(
  artifact: CapabilityArtifact,
  rawParams: Record<string, string>,
  runs: number,
  opts: Pick<ReplayOptions, "headed" | "operatorPort" | "injectFaultQueryParam">
): Promise<StabilityReport> {
  const aggRunId = newRunId();
  const aggLogger = new EvidenceLogger(aggRunId, "stability");
  await aggLogger.init();
  await aggLogger.log("info", {
    event: "stability_start",
    capability: artifact.id,
    version: artifact.version,
    runs,
    params: rawParams,
  });

  const results: StabilityRunResult[] = [];
  let successes = 0;
  for (let i = 0; i < runs; i++) {
    // confirmIrreversible: a stability run is a supervised, deliberate probe
    // used to PRODUCE the evidence an approval decision is based on — it is
    // not the unattended production invocation the approval gate exists to
    // protect, so it deliberately bypasses that gate rather than being
    // blocked by the very thing it's trying to measure.
    const result = await replayArtifact(artifact, rawParams, { ...opts, confirmIrreversible: true });
    const ok = result.status === "success" || result.status === "business_outcome";
    if (ok) successes++;
    const detail =
      result.status === "success"
        ? "success"
        : result.status === "business_outcome"
          ? `business_outcome: ${result.outcome}`
          : `${result.errorClass}: ${result.message}`;
    results.push({ runId: result.runId, status: result.status, detail, evidenceDir: result.evidenceDir });
    await aggLogger.log("result", { event: "run_complete", run: i, status: result.status, detail });
  }

  const report: StabilityReport = { runs, successes, score: successes / runs, results, evidenceDir: aggLogger.dir };
  await aggLogger.writeJson("report.json", report);
  return report;
}

/**
 * Turns a stability report into an approval decision. Meeting the
 * reliability bar is necessary but, for an artifact with an irreversible
 * step, not sufficient — that class is handled conservatively throughout
 * this project (see guardrails/policy.ts and /REPORT.md Section 6), and a
 * clean replay history doesn't substitute for a human sign-off on an action
 * that moves money. For anything else, meeting the bar is enough.
 */
export function decideApproval(artifact: CapabilityArtifact, report: StabilityReport): ApprovalDecision {
  const hasIrreversibleStep = artifact.steps.some((s) => s.risk === "irreversible");
  const meetsBar = report.runs >= MIN_STABILITY_RUNS && report.score >= STABILITY_APPROVAL_THRESHOLD;
  const scoreLine = `${report.successes}/${report.runs} runs behaved correctly (success or a declared business outcome)`;

  if (!meetsBar) {
    return {
      status: "draft",
      reason: `${scoreLine} — below the approval bar (>= ${MIN_STABILITY_RUNS} runs, ${(STABILITY_APPROVAL_THRESHOLD * 100).toFixed(0)}% success).`,
    };
  }
  if (hasIrreversibleStep) {
    return {
      status: "draft",
      reason: `${scoreLine}, meeting the reliability bar — but this artifact contains an irreversible step, so reliability alone doesn't auto-approve it; a human still has to sign off. Use --confirm-irreversible to run it unattended in the meantime, or set status to "approved" by hand once reviewed.`,
    };
  }
  return {
    status: "approved",
    reason: `${scoreLine}, meeting the reliability bar, with no irreversible step — approved for unattended replay.`,
  };
}
