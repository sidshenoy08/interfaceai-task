// Dispatches one tool call from the discovery loop against the live page,
// turning it into a recorded Step (or a policy rejection, or a pause for
// human escalation). This is the only place discovery mutates the page or
// the in-progress artifact.
import type { Page } from "playwright";
import type { ObservedElement } from "../observation/snapshot.js";
import { resolveLocator } from "../observation/resolve.js";
import { PolicyEngine } from "../guardrails/policy.js";
import type { EvidenceLogger } from "../evidence/logger.js";
import type { EscalationController } from "../escalation/controller.js";
import type { StepT, CheckpointT, FieldT, ValueRefT } from "../artifact/schema.js";

export interface DeclaredCapability {
  id: string;
  name: string;
  description: string;
  riskLevel: "read-only" | "reversible-write" | "irreversible-write";
  inputs: FieldT[];
  outputs: FieldT[];
}

/** Provider-agnostic shape for a single tool invocation, so this module doesn't depend on any particular LLM SDK's types. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface ExecuteContext {
  toolUse: ToolCall;
  page: Page;
  policy: PolicyEngine;
  declared: DeclaredCapability | null;
  steps: StepT[];
  checkpoints: CheckpointT[];
  lastSnapshotElements: Map<string, ObservedElement>;
  logger: EvidenceLogger;
  controller: EscalationController;
  opts: { goal: string };
  setDeclared: (d: DeclaredCapability) => void;
}

export interface ExecuteOutcome {
  message: string;
  isError?: boolean;
  finished?: boolean;
  summary?: string;
}

function field(f: any): FieldT {
  return {
    name: f.name,
    type: f.type,
    description: f.description,
    required: true,
    sensitive: Boolean(f.sensitive),
  };
}

export async function executeTool(ctx: ExecuteContext): Promise<ExecuteOutcome> {
  const { toolUse, page, policy, declared, steps, checkpoints, lastSnapshotElements, logger, controller, opts } = ctx;
  const input = toolUse.input as Record<string, any>;

  if (toolUse.name !== "declare_capability" && !declared) {
    return { message: "You must call declare_capability first.", isError: true };
  }

  switch (toolUse.name) {
    case "declare_capability": {
      if (declared) return { message: "Capability already declared.", isError: true };
      ctx.setDeclared({
        id: input.id,
        name: input.name,
        description: input.description,
        riskLevel: input.riskLevel,
        inputs: (input.inputs ?? []).map(field),
        outputs: (input.outputs ?? []).map(field),
      });
      return { message: "Capability declared. Proceed to interact with the page." };
    }

    case "navigate": {
      const check = policy.checkOrigin(input.url);
      if (!check.allowed) {
        await logger.log("policy", { action: "navigate", url: input.url, blocked: true, reason: check.reason });
        return { message: `Blocked by policy: ${check.reason}`, isError: true };
      }
      await page.goto(input.url, { waitUntil: "load" });
      steps.push({
        index: steps.length,
        action: "navigate",
        description: `Navigate to ${input.url}`,
        url: { literal: input.url },
        risk: "read-only",
        requiresConfirmation: false,
      });
      return { message: `Navigated. Current URL: ${page.url()}` };
    }

    case "click": {
      const element = lastSnapshotElements.get(input.ref);
      if (!element) return { message: `Unknown ref "${input.ref}". Use a ref from the latest snapshot.`, isError: true };
      if (element.disabled) return { message: `Element ${input.ref} ("${element.name}") is disabled.`, isError: true };

      const combinedText = `${input.intent} ${element.name}`;
      const risk = policy.effectiveRisk("read-only", combinedText);
      const intentKey = String(input.intent).trim().toLowerCase();

      if (risk === "irreversible") {
        const confirmCheck = policy.requiresConfirmation(risk, intentKey);
        if (!confirmCheck.allowed) {
          await logger.log("policy", { action: "click", ref: input.ref, intent: input.intent, blocked: true, reason: confirmCheck.reason });
          return {
            message: `Blocked by policy: ${confirmCheck.reason}. Call confirm_intent with intent="${input.intent}" first.`,
            isError: true,
          };
        }
      }

      const { locator } = await resolveLocator(page, element.strategies);
      await locator.click({ timeout: 5000 });
      await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {});

      steps.push({
        index: steps.length,
        action: "click",
        description: input.intent,
        target: { strategies: element.strategies },
        risk,
        requiresConfirmation: risk === "irreversible",
      });
      return { message: `Clicked "${element.name}". Current URL: ${page.url()}` };
    }

    case "type": {
      const element = lastSnapshotElements.get(input.ref);
      if (!element) return { message: `Unknown ref "${input.ref}".`, isError: true };

      if (policy.isSensitiveField(element.name) && !input.paramName) {
        return {
          message: `"${element.name}" looks like a sensitive field. You must supply paramName instead of a hardcoded value so the literal is never stored.`,
          isError: true,
        };
      }

      const { locator } = await resolveLocator(page, element.strategies);
      await locator.fill(input.text);

      const value: ValueRefT = input.paramName ? { param: input.paramName } : { literal: input.text };
      steps.push({
        index: steps.length,
        action: "type",
        description: `Type into "${element.name}"`,
        target: { strategies: element.strategies },
        value,
        risk: "read-only",
        requiresConfirmation: false,
      });
      return { message: `Typed into "${element.name}".` };
    }

    case "select": {
      const element = lastSnapshotElements.get(input.ref);
      if (!element) return { message: `Unknown ref "${input.ref}".`, isError: true };

      const { locator } = await resolveLocator(page, element.strategies);
      await locator.selectOption(input.value);

      const value: ValueRefT = input.paramName ? { param: input.paramName } : { literal: input.value };
      steps.push({
        index: steps.length,
        action: "select",
        description: `Select "${input.value}" in "${element.name}"`,
        target: { strategies: element.strategies },
        value,
        risk: "read-only",
        requiresConfirmation: false,
      });
      return { message: `Selected "${input.value}".` };
    }

    case "extract_text": {
      const element = lastSnapshotElements.get(input.ref);
      if (!element) return { message: `Unknown ref "${input.ref}".`, isError: true };

      const { locator } = await resolveLocator(page, element.strategies);
      const text = ((await locator.textContent()) ?? "").trim();

      steps.push({
        index: steps.length,
        action: "extract_text",
        description: `Extract "${element.name}" as ${input.outputName}`,
        target: { strategies: element.strategies },
        extractAs: input.outputName,
        risk: "read-only",
        requiresConfirmation: false,
      });
      return { message: `Extracted "${input.outputName}" = "${text}".` };
    }

    case "confirm_intent": {
      const intentKey = String(input.intent).trim().toLowerCase();
      policy.recordConfirmation(intentKey);
      await logger.log("policy", { action: "confirm_intent", intent: input.intent });
      return { message: `Confirmed intent: "${input.intent}".` };
    }

    case "assert_checkpoint": {
      checkpoints.push({
        afterStep: Math.max(steps.length - 1, 0),
        description: input.description,
        assert: { kind: input.kind, value: input.value },
        onFail: "escalate",
      });
      return { message: "Checkpoint recorded." };
    }

    case "finish": {
      return { message: "ok", finished: Boolean(input.success), summary: input.summary };
    }

    case "escalate": {
      await logger.log("escalation", { event: "agent_escalated", reason: input.reason, stepIndex: steps.length, url: page.url() });
      const screenshotPath = await logger.screenshot(page, `escalation-${steps.length}`);
      await controller.escalate({
        runId: logger.runId,
        capability: declared?.id ?? "unknown",
        goal: opts.goal,
        stepIndex: steps.length,
        currentUrl: page.url(),
        reason: input.reason,
        screenshotPath,
      });
      await logger.log("escalation", { event: "resumed", humanActions: controller.humanActions });
      return { message: "A human operator has resumed the session and handed control back. Re-observe the current state and continue." };
    }

    default:
      return { message: `Unknown tool "${toolUse.name}".`, isError: true };
  }
}
