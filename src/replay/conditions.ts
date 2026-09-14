import type { Page } from "playwright";
import type { DetectConditionT } from "../artifact/schema.js";
import { resolveLocator } from "../observation/resolve.js";

export async function evaluateCondition(page: Page, cond: DetectConditionT): Promise<boolean> {
  switch (cond.kind) {
    case "urlContains":
      return page.url().includes(cond.value);
    case "textPresent": {
      const text = await page.evaluate(() => document.body?.innerText ?? "");
      return text.includes(cond.value);
    }
    case "textAbsent": {
      const text = await page.evaluate(() => document.body?.innerText ?? "");
      return !text.includes(cond.value);
    }
    case "elementVisible": {
      try {
        const { locator } = await resolveLocator(page, cond.target.strategies);
        return await locator.isVisible();
      } catch {
        return false;
      }
    }
  }
}

export function describeCondition(cond: DetectConditionT): string {
  switch (cond.kind) {
    case "urlContains":
      return `URL contains "${cond.value}"`;
    case "textPresent":
      return `page text contains "${cond.value}"`;
    case "textAbsent":
      return `page text does not contain "${cond.value}"`;
    case "elementVisible":
      return `element visible (${JSON.stringify(cond.target.strategies)})`;
  }
}

export async function pageTextSummary(page: Page): Promise<string> {
  const text = await page.evaluate(() => document.body?.innerText ?? "");
  return text.slice(0, 500);
}
