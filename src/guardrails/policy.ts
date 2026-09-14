// Safety policy: an explicit, configurable allowlist plus a risk model for
// irreversible actions. Loaded once from config/allowlist.json.
//
// Design note: the agent (LLM) self-reports a risk level per action, but
// this engine does not fully trust that self-report — it cross-checks
// against a small set of textual hints ("confirm", "delete", ...) and
// escalates the effective risk to whichever is higher. An LLM that
// under-reports risk should not be able to bypass the confirmation gate.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { RiskLevelT } from "../artifact/schema.js";

export interface AllowlistConfig {
  allowedOrigins: string[];
  allowedActions: string[];
  sensitiveFieldNames: string[];
  irreversibleHints: string[];
}

export interface PolicyCheck {
  allowed: boolean;
  reason?: string;
}

const RISK_RANK: Record<RiskLevelT, number> = { "read-only": 0, reversible: 1, irreversible: 2 };

export class PolicyEngine {
  private confirmedIntents = new Set<string>();

  constructor(private config: AllowlistConfig) {}

  static async loadFromFile(file = path.resolve(process.cwd(), "config/allowlist.json")): Promise<PolicyEngine> {
    const raw = await fs.readFile(file, "utf8");
    return new PolicyEngine(JSON.parse(raw));
  }

  checkOrigin(url: string): PolicyCheck {
    try {
      const origin = new URL(url).origin;
      if (this.config.allowedOrigins.includes(origin)) return { allowed: true };
      return { allowed: false, reason: `origin ${origin} is not in the allowlist (${this.config.allowedOrigins.join(", ")})` };
    } catch {
      return { allowed: false, reason: `could not parse URL "${url}"` };
    }
  }

  checkActionType(action: string): PolicyCheck {
    if (this.config.allowedActions.includes(action)) return { allowed: true };
    return { allowed: false, reason: `action type "${action}" is not in the allowlist` };
  }

  /** Escalates a declared risk level to a heuristic floor based on the element's visible name/description. */
  effectiveRisk(declared: RiskLevelT, elementText: string): RiskLevelT {
    const lower = elementText.toLowerCase();
    const heuristicIsIrreversible = this.config.irreversibleHints.some((hint) => lower.includes(hint));
    if (heuristicIsIrreversible && RISK_RANK["irreversible"] > RISK_RANK[declared]) {
      return "irreversible";
    }
    return declared;
  }

  /** Irreversible actions require the agent to have explicitly confirmed intent for that exact target first. */
  requiresConfirmation(risk: RiskLevelT, targetKey: string): PolicyCheck {
    if (risk !== "irreversible") return { allowed: true };
    if (this.confirmedIntents.has(targetKey)) return { allowed: true };
    return {
      allowed: false,
      reason: `"${targetKey}" is an irreversible action and has not been explicitly confirmed via confirm_intent yet`,
    };
  }

  recordConfirmation(targetKey: string): void {
    this.confirmedIntents.add(targetKey);
  }

  isSensitiveField(fieldName: string): boolean {
    const lower = fieldName.toLowerCase();
    return this.config.sensitiveFieldNames.some((s) => lower.includes(s));
  }
}
