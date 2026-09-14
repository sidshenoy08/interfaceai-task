// Builds a compact, textual "accessibility-flavored" view of the current
// page: a flat list of interactive/informative elements with a role, an
// accessible name, and a set of candidate locator strategies to reach them.
//
// This is the seam between "how we perceive/act on a surface" and "the
// recorded flow": everything downstream (the LLM during discovery, the
// artifact recorder, the replay engine) only ever sees this shape. Swapping
// in a real accessibility-tree API (or an OS-level one for a desktop app)
// means reimplementing this one module — nothing else has to change.
import type { Page } from "playwright";

export type LocatorStrategy =
  | { kind: "role"; role: string; name: string; nth?: number }
  | { kind: "css"; value: string }
  | { kind: "text"; value: string }
  // Targets a "value" cell in a legacy label/value table row (<tr><td>Label</td><td>Value</td></tr>)
  // by matching the row via its label cell's text, then taking the cell at columnIndex within that
  // row. Table cells have no meaningful ARIA accessible name of their own, so role/text locators
  // can't reach them — this is the fallback that makes read-only data (balances, statuses, ids in
  // a results table) reliably extractable on a surface with no test ids.
  | { kind: "tableCell"; rowLabel: string; columnIndex: number };

export interface ObservedElement {
  ref: string;
  role: string;
  name: string;
  tag: string;
  value?: string;
  disabled?: boolean;
  strategies: LocatorStrategy[];
}

export interface Snapshot {
  url: string;
  title: string;
  elements: ObservedElement[];
  /** Rendered page text, truncated, used to detect business-outcome/interstitial banners. */
  bodyText: string;
}

// Runs in the browser context. Passed to page.evaluate() as a raw source
// string (not a function reference): tsx/esbuild rewrites nested named
// function declarations into `__name(fn, "fn")` helper calls for stack-trace
// fidelity, and that helper only exists in the Node-side compiled module —
// not in the isolated browser realm Playwright evaluates in. Serializing a
// transformed function's source via .toString() carries the dangling
// __name(...) calls with it and throws `ReferenceError: __name is not
// defined`. A plain string is never touched by that transform.
const COLLECT_ELEMENTS_SOURCE = `(() => {
  // Real (spec-ish) accessible name only: aria-label, placeholder, or —
  // for elements whose visible content genuinely IS their name (links,
  // buttons, headings, submit/button inputs) — their own text/value. This
  // deliberately does NOT fall back to a form control's raw \`name\`
  // attribute (see htmlName below): a browser's real accname algorithm
  // doesn't use it either, and a role+name or text-substring locator built
  // from it would search the whole page for that substring and can latch
  // onto an unrelated element (e.g. a "type" select matching a "Account
  // Type" label cell). Only htmlName -> a scoped [name=...] CSS locator
  // is safe for an unlabeled control.
  const trueAccessibleName = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.placeholder) return el.placeholder.trim();
      if (el.type === "submit" || el.type === "button") {
        if (el.value) return String(el.value).trim().slice(0, 120);
      }
      return "";
    }
    if (el instanceof HTMLSelectElement) return "";
    const text = (el.textContent || "").trim().replace(/\\s+/g, " ");
    if (text) return text.slice(0, 120);
    return "";
  };

  const roleFor = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      const type = el.type;
      if (type === "submit" || type === "button") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4") return "heading";
    if (tag === "table") return "table";
    return null;
  };

  const candidates = Array.from(
    document.querySelectorAll("a, button, input, textarea, select, h1, h2, h3, h4")
  );

  const out = [];
  for (const el of candidates) {
    const role = roleFor(el);
    if (!role) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const trueName = trueAccessibleName(el);
    const disabled = el.disabled === true;
    const value =
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : undefined;
    const htmlName =
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
        ? el.name || undefined
        : undefined;
    const name = trueName || htmlName || "";
    out.push({ role, name, trueName, tag: el.tagName.toLowerCase(), value, disabled, htmlName });
  }

  // Second pass: expose "value" cells in label/value table rows
  // (<tr><td>Label</td><td>Value</td></tr>) as extractable elements. A data
  // cell has no ARIA accessible name of its own, so without this pass there
  // would be no way for a caller to reference, say, a balance in a table —
  // only headings and interactive controls would be visible.
  const rows = Array.from(document.querySelectorAll("tr"));
  for (const row of rows) {
    const cells = Array.from(row.children).filter((c) => c.tagName === "TD");
    for (let idx = 1; idx < cells.length; idx++) {
      const cell = cells[idx];
      const labelCell = cells[idx - 1];
      // Skip layout/container rows (a cell that itself wraps a nested
      // <table> is structure, not data — this is what separates a genuine
      // "Label | Value" data row from this app's own outer page layout,
      // which is also a <tr> with two <td>s).
      if (labelCell.querySelector("table") || cell.querySelector("table")) continue;
      const rowLabel = (labelCell.textContent || "").trim().replace(/\\s+/g, " ");
      const ownText = (cell.textContent || "").trim().replace(/\\s+/g, " ");
      if (!rowLabel || !ownText) continue;
      const rect = cell.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      out.push({
        role: "cell",
        name: rowLabel,
        tag: "td",
        value: ownText,
        disabled: false,
        rowLabel,
        columnIndex: idx,
      });
    }
  }

  return out;
})()`;

interface RawObservedElement {
  role: string;
  name: string;
  /** The real accessible name (see trueAccessibleName above); empty when the element has none. */
  trueName?: string;
  tag: string;
  value?: string;
  disabled?: boolean;
  /**
   * The HTML `name` attribute of a form control, distinct from its ARIA
   * accessible name. Legacy server-rendered forms routinely have the former
   * (required for POST submission) but not the latter (no <label>,
   * aria-label, or placeholder) — browsers do NOT use the `name` attribute
   * when computing accessible name, so a role+name locator alone will not
   * find these controls. We fall back to a `[name=...]` CSS locator for
   * exactly this case.
   */
  htmlName?: string;
  /** Present only for role "cell": the text of the preceding cell in the same row, and this cell's column index. */
  rowLabel?: string;
  columnIndex?: number;
}

export async function captureSnapshot(page: Page): Promise<Snapshot> {
  const raw = await page.evaluate<RawObservedElement[]>(COLLECT_ELEMENTS_SOURCE);
  const bodyText = (await page.evaluate(() => document.body?.innerText ?? "")).slice(0, 4000);

  // Track how many times we've seen a given (role, name) pair so we can
  // disambiguate with an nth-match strategy when names repeat (e.g. two
  // "Continue" buttons on different rows).
  const seen = new Map<string, number>();
  const elements: ObservedElement[] = raw.map((el, i) => {
    const key = `${el.role}::${el.name}`;
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);

    const strategies: LocatorStrategy[] = [];
    if (el.role === "cell" && el.rowLabel !== undefined && el.columnIndex !== undefined) {
      strategies.push({ kind: "tableCell", rowLabel: el.rowLabel, columnIndex: el.columnIndex });
    } else if (el.trueName) {
      // A real accessible name: role+name and a visible-text search are both
      // meaningful and safe (they're matching what a human would actually
      // see as this element's label).
      strategies.push({ kind: "role", role: el.role, name: el.trueName, nth: nth > 0 ? nth : undefined });
      strategies.push({ kind: "text", value: el.trueName });
      if (el.htmlName) strategies.push({ kind: "css", value: `[name="${el.htmlName}"]` });
    } else if (el.htmlName) {
      // No real accessible name — only the raw HTML `name` attribute. A
      // role/text locator here would search the whole page for a substring
      // match and can latch onto an unrelated element; a scoped attribute
      // selector is the only safe strategy.
      strategies.push({ kind: "css", value: `[name="${el.htmlName}"]` });
    }
    return {
      ref: `e${i + 1}`,
      role: el.role,
      name: el.name,
      tag: el.tag,
      value: el.value,
      disabled: el.disabled,
      strategies,
    };
  });

  return {
    url: page.url(),
    title: await page.title(),
    elements,
    bodyText,
  };
}

export function formatSnapshotForModel(snapshot: Snapshot): string {
  const lines = snapshot.elements
    .filter((e) => e.name || e.role === "table")
    .map((e) => {
      const bits = [`[${e.ref}]`, e.role];
      if (e.name) bits.push(`"${e.name}"`);
      if (e.value) bits.push(`value="${e.value}"`);
      if (e.disabled) bits.push("(disabled)");
      return bits.join(" ");
    });
  return [
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title}`,
    ``,
    `Interactive elements:`,
    ...lines,
    ``,
    `Visible text (truncated):`,
    snapshot.bodyText,
  ].join("\n");
}
