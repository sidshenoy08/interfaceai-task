// Resolves a LocatorStrategy fallback chain to a live Playwright Locator.
// Used both by the discovery agent (acting on a ref from the current
// snapshot) and by the replay engine (resolving a persisted strategy chain
// against a freshly-observed page, with no refs available).
import type { Locator, Page } from "playwright";
import type { LocatorStrategy } from "./snapshot.js";

const ALLOWED_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "heading",
  "table",
]);

export interface ResolveResult {
  locator: Locator;
  strategyUsed: LocatorStrategy;
  strategyIndex: number;
}

export interface ResolveAttempt {
  strategy: LocatorStrategy;
  matchCount: number;
  error?: string;
}

export class LocatorResolutionError extends Error {
  constructor(
    public readonly strategies: LocatorStrategy[],
    public readonly attempts: ResolveAttempt[]
  ) {
    super(
      `Could not resolve any locator strategy. Tried ${attempts.length}: ` +
        attempts.map((a) => `${describeStrategy(a.strategy)} -> ${a.matchCount} match(es)${a.error ? ` (${a.error})` : ""}`).join("; ")
    );
    this.name = "LocatorResolutionError";
  }
}

export function describeStrategy(s: LocatorStrategy): string {
  if (s.kind === "role") return `role=${s.role} name="${s.name}"${s.nth ? ` nth=${s.nth}` : ""}`;
  if (s.kind === "css") return `css=${s.value}`;
  if (s.kind === "tableCell") return `tableCell row="${s.rowLabel}" col=${s.columnIndex}`;
  return `text="${s.value}"`;
}

function buildLocator(page: Page, strategy: LocatorStrategy): Locator {
  if (strategy.kind === "role") {
    if (!ALLOWED_ROLES.has(strategy.role)) {
      throw new Error(`unsupported role "${strategy.role}"`);
    }
    const base = page.getByRole(strategy.role as any, { name: strategy.name, exact: false });
    return strategy.nth != null ? base.nth(strategy.nth) : base.first();
  }
  if (strategy.kind === "css") {
    return page.locator(strategy.value).first();
  }
  if (strategy.kind === "tableCell") {
    // Anchored, exact-text match (not substring `hasText`): under nested
    // tables — the norm for this kind of legacy layout — a naive substring
    // match against an outer wrapper cell's full descendant text will also
    // "contain" the label and, being the outermost match, win `.first()`
    // over the actual leaf cell. Anchoring to the trimmed text rules out
    // every ancestor except the one true leaf label cell.
    const escaped = strategy.rowLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exact = new RegExp(`^\\s*${escaped}\\s*$`);
    const labelCell = page.locator("td", { hasText: exact }).first();
    // XPath parent/child axes give the label cell's *direct* parent <tr> and
    // that row's *direct* <td> children — not any containing ancestor row or
    // any td nested arbitrarily deep inside a sub-table, which a descendant
    // (`has`) match would also pick up.
    const row = labelCell.locator("xpath=parent::tr");
    return row.locator("xpath=./td").nth(strategy.columnIndex);
  }
  return page.getByText(strategy.value, { exact: false }).first();
}

/**
 * Tries each strategy in order. A strategy "succeeds" if it resolves to at
 * least one attached element in the DOM. We deliberately don't require
 * visibility here (the caller decides whether to wait for visibility) so
 * that timing issues are surfaced as distinct, debuggable states rather than
 * folded into "not found."
 */
export async function resolveLocator(page: Page, strategies: LocatorStrategy[]): Promise<ResolveResult> {
  const attempts: ResolveAttempt[] = [];
  for (let i = 0; i < strategies.length; i++) {
    const strategy = strategies[i];
    if (!strategy) continue;
    try {
      const locator = buildLocator(page, strategy);
      const count = await locator.count();
      attempts.push({ strategy, matchCount: count });
      if (count >= 1) {
        return { locator, strategyUsed: strategy, strategyIndex: i };
      }
    } catch (err) {
      attempts.push({ strategy, matchCount: 0, error: (err as Error).message });
    }
  }
  throw new LocatorResolutionError(strategies, attempts);
}
