// The goal-driven discovery agent loop: observe -> decide -> act, with a
// real LLM in the decision seat, against a live browser. On success it
// hands off the recorded steps/checkpoints to the artifact layer. Nothing
// here is replayed later without the LLM — that's the point of the artifact.
import OpenAI from "openai";
import { chromium } from "playwright";
import { TOOLS } from "./tools.js";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool, type DeclaredCapability, type ToolCall } from "./execute.js";
import { captureSnapshot, formatSnapshotForModel, type ObservedElement } from "../observation/snapshot.js";
import { PolicyEngine } from "../guardrails/policy.js";
import { EvidenceLogger, newRunId } from "../evidence/logger.js";
import { EscalationController } from "../escalation/controller.js";
import { startOperatorServer } from "../escalation/server.js";
import { saveArtifact, nextVersion } from "../artifact/store.js";
import { enrichArtifact } from "../artifact/harden.js";
import type { CapabilityArtifact, StepT, CheckpointT } from "../artifact/schema.js";

const MAX_STEPS = 20;

export interface DiscoveryOptions {
  goal: string;
  baseUrl: string;
  allowedOrigins: string[];
  model: string;
  apiKey: string;
  headed: boolean;
  operatorPort: number;
}

export interface DiscoveryResult {
  runId: string;
  success: boolean;
  artifactPath?: string;
  summary: string;
  evidenceDir: string;
}

type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;

export async function runDiscovery(opts: DiscoveryOptions): Promise<DiscoveryResult> {
  const runId = newRunId();
  const logger = new EvidenceLogger(runId, "discovery");
  await logger.init();
  const policy = await PolicyEngine.loadFromFile();
  const controller = new EscalationController();
  const operatorServer = startOperatorServer(controller, logger, opts.operatorPort);

  const browser = await chromium.launch({ headless: !opts.headed });
  const context = await browser.newContext();
  const page = await context.newPage();
  controller.attachPage(page);

  const openai = new OpenAI({ apiKey: opts.apiKey });

  await logger.log("info", { event: "discovery_start", goal: opts.goal, baseUrl: opts.baseUrl, model: opts.model });

  let declared: DeclaredCapability | null = null;
  const steps: StepT[] = [];
  const checkpoints: CheckpointT[] = [];
  let lastSnapshotElements: Map<string, ObservedElement> = new Map();
  let success = false;
  let summary = "Stopped without an explicit finish (max steps reached).";

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt({ baseUrl: opts.baseUrl, allowedOrigins: opts.allowedOrigins }) },
    { role: "user", content: `Goal: ${opts.goal}` },
  ];

  try {
    for (let turn = 0; turn < MAX_STEPS; turn++) {
      const snapshot = await captureSnapshot(page);
      lastSnapshotElements = new Map(snapshot.elements.map((e) => [e.ref, e]));
      const screenshotBuf = await page.screenshot();
      await logger.log("observation", { turn, url: snapshot.url, elementCount: snapshot.elements.length });

      messages.push({
        role: "user",
        content: [
          { type: "text", text: formatSnapshotForModel(snapshot) },
          { type: "image_url", image_url: { url: `data:image/png;base64,${screenshotBuf.toString("base64")}` } },
        ],
      });

      const response = await openai.chat.completions.create({
        model: opts.model,
        max_tokens: 1024,
        tools: TOOLS,
        tool_choice: "auto",
        messages,
      });

      const choice = response.choices[0];
      const assistantMessage = choice?.message;
      if (!assistantMessage) throw new Error("model returned no choices");
      messages.push(assistantMessage as ChatMessage);

      const toolCalls = (assistantMessage.tool_calls ?? []).filter(
        (tc): tc is OpenAI.Chat.ChatCompletionMessageToolCall & { type: "function" } => tc.type === "function"
      );

      if (toolCalls.length === 0) {
        await logger.log("decision", { turn, note: "no tool_call in response", text: assistantMessage.content });
        messages.push({ role: "user", content: "Please call exactly one tool to make progress." });
        continue;
      }

      let stop = false;

      for (const rawCall of toolCalls) {
        let parsedInput: Record<string, any>;
        try {
          parsedInput = JSON.parse(rawCall.function.arguments || "{}");
        } catch {
          parsedInput = {};
        }
        const toolCall: ToolCall = { id: rawCall.id, name: rawCall.function.name, input: parsedInput };

        await logger.log("decision", { turn, tool: toolCall.name, input: toolCall.input });
        const outcome = await executeTool({
          toolUse: toolCall,
          page,
          policy,
          declared,
          steps,
          checkpoints,
          lastSnapshotElements,
          logger,
          controller,
          opts: { goal: opts.goal },
          setDeclared: (d) => {
            declared = d;
          },
        });
        await logger.log("action", { turn, tool: toolCall.name, message: outcome.message, isError: outcome.isError ?? false });
        messages.push({ role: "tool", tool_call_id: toolCall.id, content: outcome.message });
        if (outcome.finished !== undefined) {
          success = outcome.finished;
          summary = outcome.summary ?? summary;
          stop = true;
        }
      }
      if (stop) break;
    }
  } catch (err) {
    await logger.log("error", { message: (err as Error).message, stack: (err as Error).stack });
    summary = `Discovery failed with an error: ${(err as Error).message}`;
  }

  let artifactPath: string | undefined;
  if (success && declared && steps.length > 0) {
    const cap = declared as DeclaredCapability;
    const version = await nextVersion(cap.id);
    let artifact: CapabilityArtifact = {
      id: cap.id,
      version,
      status: "draft",
      name: cap.name,
      description: cap.description,
      target: { app: "core-banking-demo", baseUrl: opts.baseUrl },
      riskLevel: cap.riskLevel,
      inputs: cap.inputs,
      outputs: cap.outputs,
      steps,
      checkpoints,
      businessOutcomes: [],
      interstitials: [],
      provenance: { discoveryRunId: runId, model: opts.model, createdAt: new Date().toISOString() },
    };
    artifact = enrichArtifact(artifact);
    artifactPath = await saveArtifact(artifact);
    await logger.log("result", { event: "artifact_saved", artifactPath, capability: cap.id, version, status: artifact.status });
  } else {
    await logger.log("result", { event: "discovery_incomplete", success, summary });
  }

  await logger.writeJson("transcript.json", messages);
  await logger.screenshot(page, "final_state").catch(() => {});

  await context.close();
  await browser.close();
  operatorServer.close();

  return { runId, success, artifactPath, summary, evidenceDir: logger.dir };
}
