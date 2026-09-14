// Redaction of regulated/sensitive data before it is persisted into logs,
// screenshots' companion data, or artifacts. This is a "never" boundary, not
// a best-effort one: callers should route all persisted strings through
// redactText, and all typed field values through redactFieldValue.
const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: "credit-card", re: /\b(?:\d[ -]?){13,16}\b/g },
  { name: "email", re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
];

export function redactText(input: string): string {
  let out = input;
  for (const { name, re } of PATTERNS) {
    out = out.replace(re, `[REDACTED:${name}]`);
  }
  return out;
}

export function redactFieldValue(fieldName: string, value: string, sensitiveFieldNames: string[]): string {
  const lower = fieldName.toLowerCase();
  if (sensitiveFieldNames.some((s) => lower.includes(s))) {
    return "[REDACTED]";
  }
  return redactText(value);
}
