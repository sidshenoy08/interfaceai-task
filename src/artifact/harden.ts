// Deliberate design decision (see /REPORT.md, "Determinism & error handling"):
// a single successful discovery run only ever observes the happy path. It
// cannot responsibly *guess* every business outcome or interstitial the
// target app can produce — those represent institutional knowledge about
// the app, not something safely inferable from one transcript.
//
// So: discovery records the mechanical flow (steps + checkpoints). Known
// exceptional states are attached here, at review time, before an artifact
// is approved for unattended production replay. In a real system this would
// be a human-in-the-loop review step (or accumulated from prior incident
// reports); here it's applied automatically per capability id to keep the
// demo runnable end-to-end while keeping the seam honest and visible.
//
// Known limitation: keying this off `artifact.id` is brittle in exactly the
// way it looks — the id is freeform text the LLM chooses during discovery
// (declare_capability), not a stable identifier assigned before recording,
// so two runs of "the same" capability can mint different ids (this
// happened during development: "open-sub-account" vs.
// "open-savings-sub-account" for the same goal). A real review step would
// key off something the reviewer assigns or confirms, not model output.
import type { CapabilityArtifact } from "./schema.js";

const KNOWN_BUSINESS_OUTCOMES: Record<string, CapabilityArtifact["businessOutcomes"]> = {
  "lookup-member-balance": [
    {
      name: "member_not_found",
      description: "The member id does not exist in the system.",
      detect: { kind: "textPresent", value: "No member record found" },
    },
    {
      name: "access_restricted",
      description: "The member record exists but access is restricted.",
      detect: { kind: "textPresent", value: "Access to this member record is restricted" },
    },
  ],
  "open-savings-sub-account": [
    {
      name: "invalid_deposit",
      description: "The requested initial deposit failed validation (below minimum, above maximum, or non-numeric).",
      detect: { kind: "textPresent", value: "Invalid initial deposit" },
    },
  ],
};

const KNOWN_INTERSTITIALS: Record<string, CapabilityArtifact["interstitials"]> = {
  "lookup-member-balance": [
    {
      name: "session_renewed",
      description: "An unexpected 'session renewed' interstitial that requires an extra confirm click before the recorded flow can continue.",
      detect: { kind: "textPresent", value: "Your session was silently renewed" },
      dismiss: { action: "click", target: { strategies: [{ kind: "role", role: "link", name: "Continue" }] } },
    },
  ],
};

export function enrichArtifact(artifact: CapabilityArtifact): CapabilityArtifact {
  const businessOutcomes = KNOWN_BUSINESS_OUTCOMES[artifact.id] ?? [];
  const interstitials = KNOWN_INTERSTITIALS[artifact.id] ?? [];
  // Gate on what the recording actually does, not its self-declared risk
  // category (see replay/executor.ts) — an "irreversible-write" capability
  // whose recorded steps never reach the real submit is as safe to
  // auto-approve as a read-only one.
  //
  // This is only the first pass at "approved", made at record time from
  // static structure alone. It isn't the last word: once an artifact has
  // been replayed multiple times with fixed inputs, replay/stability.ts's
  // `decideApproval` re-derives status from actual replay evidence (a
  // measured success rate, not a guess) and can promote or demote it
  // independently — see /REPORT.md, "Confidence & approval".
  const hasIrreversibleStep = artifact.steps.some((s) => s.risk === "irreversible");
  const status = hasIrreversibleStep ? "draft" : "approved";
  return { ...artifact, businessOutcomes, interstitials, status };
}
