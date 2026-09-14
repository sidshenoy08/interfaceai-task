// Structured, append-only evidence for a single run. Every discovery and
// replay run gets its own directory under /evidence with a JSONL log plus
// any screenshots captured along the way. This is the "structured log of
// what the agent did and why" required by the brief, and the substrate the
// escalation flow uses to hand a human enough context to act.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { redactText } from "../guardrails/redaction.js";

export type LogEntryType =
  | "observation"
  | "decision"
  | "action"
  | "policy"
  | "result"
  | "error"
  | "human_action"
  | "escalation"
  | "info";

export interface LogEntry {
  ts: string;
  runId: string;
  type: LogEntryType;
  detail: Record<string, unknown>;
}

function deepRedact(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(deepRedact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepRedact(v)]));
  }
  return value;
}

export class EvidenceLogger {
  readonly dir: string;

  constructor(
    public readonly runId: string,
    kind: "discovery" | "replay"
  ) {
    this.dir = path.resolve(process.cwd(), "evidence", `${kind}-${runId}`);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async log(type: LogEntryType, detail: Record<string, unknown>): Promise<void> {
    const entry: LogEntry = { ts: new Date().toISOString(), runId: this.runId, type, detail: deepRedact(detail) as Record<string, unknown> };
    await fs.appendFile(path.join(this.dir, "log.jsonl"), JSON.stringify(entry) + "\n", "utf8");
    // eslint-disable-next-line no-console
    console.log(`[${type}]`, JSON.stringify(entry.detail).slice(0, 200));
  }

  async screenshot(page: Page, label: string): Promise<string> {
    const file = path.join(this.dir, `${label}.png`);
    await page.screenshot({ path: file });
    return file;
  }

  async writeJson(name: string, data: unknown): Promise<string> {
    const file = path.join(this.dir, name);
    await fs.writeFile(file, JSON.stringify(deepRedact(data), null, 2), "utf8");
    return file;
  }
}

export function newRunId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${ts}-${Math.random().toString(36).slice(2, 8)}`;
}
