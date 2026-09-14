// Deterministic replay: the production execution path. No LLM in the
// decision loop — every action comes straight from the artifact. The only
// judgment calls made here are the ones the artifact already encodes
// (locator fallback chains, declared business outcomes/interstitials,
// checkpoint failure policy) plus the guardrail checks every action must
// clear regardless of what recorded it.
import { chromium, type Page } from "playwright";
import type { CapabilityArtifact, StepT, BusinessOutcomeT, InterstitialT, CheckpointT, FieldT } from "../artifact/schema.js";
import { resolveLocator, LocatorResolutionError } from "../observation/resolve.js";
import { evaluateCondition, describeCondition, pageTextSummary } from "./conditions.js";
import { buildParams, resolveValue, InputValidationError } from "./params.js";
import { PolicyEngine } from "../guardrails/policy.js";
import { redactFieldValue } from "../guardrails/redaction.js";
import { EvidenceLogger, newRunId } from "../evidence/logger.js";
import { EscalationController } from "../escalation/controller.js";
import { startOperatorServer } from "../escalation/server.js";

export type ReplayResult =
  | { status: "success"; outputs: Record<string, unknown>; evidenceDir: string; runId: string }
  | { status: "business_outcome"; outcome: string; description: string; evidenceDir: string; runId: string }
  | {
      status: "error";
      errorClass: "hard_failure" | "config_error";
      step?: number;
      expected?: string;
      observed?: string;
      message: string;
      evidenceDir: string;
      runId: string;
    };

export interface ReplayOptions {
  headed: boolean;
  operatorPort: number;
  /** Test-only hook: appends this query string to every navigate URL, used to demonstrate handling of an unexpected/injected state. Never used by real callers. */
  injectFaultQueryParam?: string;
  /** Irreversible-write artifacts with status "draft" require this flag, so an unattended caller can't accidentally run an unapproved money-moving capability. */
  confirmIrreversible?: boolean;
}

function coerceOutput(field: FieldT | undefined, text: string): unknown {
  if (!field) return text;
  if (field.type === "number") {
    const n = Number(text.replace(/[$,]/g, ""));
    return Number.isNaN(n) ? text : n;
  }
  return text;
}

function detectBusinessOutcome(bodyText: string, outcomes: BusinessOutcomeT[]): BusinessOutcomeT | null {
  for (const o of outcomes) {
    if (o.detect.kind === "textPresent" && bodyText.includes(o.detect.value)) return o;
  }
  return null;
}

export async function replayArtifact(
  artifact: CapabilityArtifact,
  rawParams: Record<string, string>,
  opts: ReplayOptions
): Promise<ReplayResult> {
  const runId = newRunId();
  const logger = new EvidenceLogger(runId, "replay");
  await logger.init();

  // Gate on what the recorded flow actually DOES, not its self-declared
  // category: an artifact labeled "irreversible-write" that only navigates
  // to a review screen (never clicks the real submit) is exactly as safe to
  // unattended-replay as a read-only one, so it shouldn't need approval.
  const hasIrreversibleStep = artifact.steps.some((s) => s.risk === "irreversible");
  if (hasIrreversibleStep && artifact.status !== "approved" && !opts.confirmIrreversible) {
    const message = `Artifact "${artifact.id}" v${artifact.version} contains an irreversible step and status="${artifact.status}" (not approved). Pass --confirm-irreversible to run it unattended anyway.`;
    await logger.log("policy", { blocked: true, reason: message });
    return { status: "error", errorClass: "config_error", message, evidenceDir: logger.dir, runId };
  }

  let params: Record<string, unknown>;
  try {
    params = buildParams(artifact, rawParams);
  } catch (err) {
    await logger.log("error", { message: (err as Error).message });
    return { status: "error", errorClass: "config_error", message: (err as Error).message, evidenceDir: logger.dir, runId };
  }

  const policy = await PolicyEngine.loadFromFile();
  const controller = new EscalationController();
  const operatorServer = startOperatorServer(controller, logger, opts.operatorPort);

  const browser = await chromium.launch({ headless: !opts.headed });
  const context = await browser.newContext();

  if (opts.injectFaultQueryParam) {
    // Test-harness-only fault injection, used to demonstrate escalation on an
    // exceptional state the original discovery run never saw. Rewrites the
    // first bare (query-less) GET navigation to carry the fault flag,
    // regardless of whether that navigation came from an explicit "navigate"
    // step or from clicking a link — a per-step URL edit couldn't do that.
    // Never used by a real caller; replay never mutates production traffic.
    await context.route("**/*", (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "GET" && !url.search) {
        url.search = opts.injectFaultQueryParam!;
        route.continue({ url: url.toString() });
      } else {
        route.continue();
      }
    });
  }

  const page = await context.newPage();
  controller.attachPage(page);

  const sensitiveInputNames = new Set(artifact.inputs.filter((f) => f.sensitive).map((f) => f.name));
  const loggedParams = Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, sensitiveInputNames.has(k) ? "[REDACTED]" : v])
  );
  await logger.log("info", { event: "replay_start", capability: artifact.id, version: artifact.version, params: loggedParams });

  const outputs: Record<string, unknown> = {};
  const outputFieldByName = new Map(artifact.outputs.map((f) => [f.name, f]));

  const cleanup = async () => {
    await context.close();
    await browser.close();
    operatorServer.close();
  };

  try {
    for (const step of artifact.steps) {
      const stepResult = await performStep(page, step, params, policy, logger, outputs, outputFieldByName);
      if (!stepResult.ok) {
        await logger.log("error", { step: step.index, action: step.action, message: stepResult.error });
        const screenshotPath = await logger.screenshot(page, `action-fail-${step.index}`).catch(() => undefined);
        await controller.escalate({
          runId,
          capability: artifact.id,
          stepIndex: step.index,
          currentUrl: page.url(),
          reason: `Could not perform step ${step.index} (${step.action}): ${stepResult.error}`,
          screenshotPath,
        });
        const retry = await performStep(page, step, params, policy, logger, outputs, outputFieldByName);
        if (!retry.ok) {
          await logger.log("result", { event: "hard_failure", step: step.index });
          await cleanup();
          return {
            status: "error",
            errorClass: "hard_failure",
            step: step.index,
            expected: `to be able to ${step.action} on the target for "${step.description}"`,
            observed: retry.error,
            message: `Step ${step.index} (${step.action}) failed even after human intervention.`,
            evidenceDir: logger.dir,
            runId,
          };
        }
      }

      // Global condition check: terminal business outcomes, then recoverable interstitials.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const bodyText = await page.evaluate(() => document.body?.innerText ?? "");
        const outcome = detectBusinessOutcome(bodyText, artifact.businessOutcomes);
        if (outcome) {
          await logger.log("result", { event: "business_outcome", outcome: outcome.name });
          await cleanup();
          return { status: "business_outcome", outcome: outcome.name, description: outcome.description, evidenceDir: logger.dir, runId };
        }

        const interstitial = detectInterstitialFromText(bodyText, artifact.interstitials);
        if (!interstitial) break;

        await logger.log("result", { event: "interstitial_detected", name: interstitial.name });
        try {
          const { locator } = await resolveLocator(page, interstitial.dismiss.target.strategies);
          await locator.click({ timeout: 5000 });
          await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {});
          await logger.log("result", { event: "interstitial_dismissed", name: interstitial.name });
        } catch (err) {
          await logger.log("error", { message: `could not auto-dismiss interstitial "${interstitial.name}": ${(err as Error).message}` });
          const screenshotPath = await logger.screenshot(page, `interstitial-${step.index}`).catch(() => undefined);
          await controller.escalate({
            runId,
            capability: artifact.id,
            stepIndex: step.index,
            currentUrl: page.url(),
            reason: `Unrecognized/undismissable interstitial "${interstitial.name}" encountered after step ${step.index}.`,
            screenshotPath,
          });
        }
      }

      for (const cp of artifact.checkpoints.filter((c) => c.afterStep === step.index)) {
        const result = await verifyCheckpoint(page, cp, logger, controller, artifact, runId, step.index);
        if (!result.ok) {
          await cleanup();
          return {
            status: "error",
            errorClass: "hard_failure",
            step: step.index,
            expected: describeCondition(cp.assert),
            observed: result.observed,
            message: `Checkpoint "${cp.description}" failed after step ${step.index}.`,
            evidenceDir: logger.dir,
            runId,
          };
        }
      }
    }

    await logger.log("result", { event: "success", outputs });
    await cleanup();
    return { status: "success", outputs, evidenceDir: logger.dir, runId };
  } catch (err) {
    await logger.log("error", { message: (err as Error).message, stack: (err as Error).stack });
    await cleanup();
    return { status: "error", errorClass: "hard_failure", message: (err as Error).message, evidenceDir: logger.dir, runId };
  }
}

function detectInterstitialFromText(bodyText: string, interstitials: InterstitialT[]): InterstitialT | null {
  for (const i of interstitials) {
    if (i.detect.kind === "textPresent" && bodyText.includes(i.detect.value)) return i;
  }
  return null;
}

async function performStep(
  page: Page,
  step: StepT,
  params: Record<string, unknown>,
  policy: PolicyEngine,
  logger: EvidenceLogger,
  outputs: Record<string, unknown>,
  outputFieldByName: Map<string, FieldT>
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    switch (step.action) {
      case "navigate": {
        if (!step.url) return { ok: false, error: "navigate step missing url" };
        const url = resolveValue(step.url, params);
        const check = policy.checkOrigin(url);
        if (!check.allowed) return { ok: false, error: `blocked by policy: ${check.reason}` };
        await page.goto(url, { waitUntil: "load" });
        await logger.log("action", { step: step.index, action: "navigate", url });
        return { ok: true };
      }
      case "click": {
        if (!step.target) return { ok: false, error: "click step missing target" };
        const { locator, strategyUsed } = await resolveLocator(page, step.target.strategies);
        await logger.log("action", { step: step.index, action: "click", strategyUsed });
        await locator.click({ timeout: 5000 });
        await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {});
        return { ok: true };
      }
      case "type": {
        if (!step.target || !step.value) return { ok: false, error: "type step missing target/value" };
        const { locator, strategyUsed } = await resolveLocator(page, step.target.strategies);
        const value = resolveValue(step.value, params);
        await logger.log("action", {
          step: step.index,
          action: "type",
          strategyUsed,
          value: "param" in step.value ? redactFieldValue(step.value.param, value, []) : "[literal]",
        });
        await locator.fill(value);
        return { ok: true };
      }
      case "select": {
        if (!step.target || !step.value) return { ok: false, error: "select step missing target/value" };
        const { locator, strategyUsed } = await resolveLocator(page, step.target.strategies);
        const value = resolveValue(step.value, params);
        await logger.log("action", { step: step.index, action: "select", strategyUsed, value });
        await locator.selectOption(value);
        return { ok: true };
      }
      case "extract_text": {
        if (!step.target || !step.extractAs) return { ok: false, error: "extract_text step missing target/extractAs" };
        const { locator, strategyUsed } = await resolveLocator(page, step.target.strategies);
        const text = ((await locator.textContent()) ?? "").trim();
        outputs[step.extractAs] = coerceOutput(outputFieldByName.get(step.extractAs), text);
        await logger.log("action", { step: step.index, action: "extract_text", strategyUsed, extractAs: step.extractAs });
        return { ok: true };
      }
      default:
        return { ok: false, error: `unknown action "${step.action}"` };
    }
  } catch (err) {
    if (err instanceof LocatorResolutionError || err instanceof InputValidationError) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: (err as Error).message };
  }
}

async function verifyCheckpoint(
  page: Page,
  cp: CheckpointT,
  logger: EvidenceLogger,
  controller: EscalationController,
  artifact: CapabilityArtifact,
  runId: string,
  stepIndex: number
): Promise<{ ok: true } | { ok: false; observed: string }> {
  let holds = await evaluateCondition(page, cp.assert);
  if (holds) return { ok: true };

  if (cp.onFail === "retry" && cp.retry) {
    for (let i = 0; i < cp.retry.attempts && !holds; i++) {
      await page.waitForTimeout(cp.retry.delayMs);
      holds = await evaluateCondition(page, cp.assert);
    }
    if (holds) return { ok: true };
  }

  if (cp.onFail === "fail") {
    return { ok: false, observed: await pageTextSummary(page) };
  }

  // "escalate" (or a "retry" with no retry config, or an exhausted retry budget)
  await logger.log("escalation", { event: "checkpoint_failed", checkpoint: cp.description, step: stepIndex });
  const screenshotPath = await logger.screenshot(page, `checkpoint-fail-${stepIndex}`).catch(() => undefined);
  await controller.escalate({
    runId,
    capability: artifact.id,
    stepIndex,
    currentUrl: page.url(),
    reason: `Checkpoint failed: ${cp.description} (expected ${describeCondition(cp.assert)})`,
    screenshotPath,
  });
  holds = await evaluateCondition(page, cp.assert);
  if (holds) {
    await logger.log("result", { event: "checkpoint_recovered_by_human", step: stepIndex });
    return { ok: true };
  }
  return { ok: false, observed: await pageTextSummary(page) };
}
