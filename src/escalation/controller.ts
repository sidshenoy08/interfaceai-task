// The control-transfer model.
//
// Exactly one of {automation, human} is "in control" at any time. Automation
// (the discovery loop or the replay engine) calls `escalate()` when it can't
// safely proceed; that call suspends the caller (it does not return) until a
// human calls `resume()`. Both sides act on the *same* `Page` instance
// (attached via `attachPage`), so the human is operating the live session
// the automation was using, not a fresh one — the operator console below
// never opens a new browser context.
import type { Page } from "playwright";

export type Controller = "automation" | "human";

export interface InterventionRequest {
  runId: string;
  capability: string;
  goal?: string;
  stepIndex: number;
  currentUrl: string;
  reason: string;
  screenshotPath?: string;
  createdAt: string;
}

export interface HumanActionRecord {
  ts: string;
  action: string;
  detail: Record<string, unknown>;
}

export class EscalationController {
  controller: Controller = "automation";
  page: Page | null = null;
  currentRequest: InterventionRequest | null = null;
  readonly humanActions: HumanActionRecord[] = [];

  private resumeWaiters: Array<() => void> = [];

  attachPage(page: Page): void {
    this.page = page;
  }

  get isEscalated(): boolean {
    return this.controller === "human";
  }

  /** Suspends the caller until a human resumes the run. Never rejects. */
  async escalate(request: Omit<InterventionRequest, "createdAt">): Promise<void> {
    this.controller = "human";
    this.currentRequest = { ...request, createdAt: new Date().toISOString() };
    await new Promise<void>((resolve) => {
      this.resumeWaiters.push(resolve);
    });
  }

  resume(): void {
    if (this.controller !== "human") return;
    this.controller = "automation";
    this.currentRequest = null;
    const waiters = this.resumeWaiters.splice(0);
    for (const w of waiters) w();
  }

  recordHumanAction(action: string, detail: Record<string, unknown>): void {
    this.humanActions.push({ ts: new Date().toISOString(), action, detail });
  }
}
