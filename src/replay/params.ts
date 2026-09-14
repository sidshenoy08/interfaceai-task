import type { CapabilityArtifact, FieldT } from "../artifact/schema.js";

export class InputValidationError extends Error {}

function coerce(field: FieldT, raw: string): unknown {
  if (field.type === "number") {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new InputValidationError(`input "${field.name}" must be a number, got "${raw}"`);
    return n;
  }
  if (field.type === "boolean") return raw === "true";
  return raw;
}

/** Validates and coerces raw CLI-style string params ("memberId=12345") against the artifact's declared inputs. */
export function buildParams(artifact: CapabilityArtifact, raw: Record<string, string>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const field of artifact.inputs) {
    const value = raw[field.name];
    if (value === undefined) {
      if (field.required) throw new InputValidationError(`missing required input "${field.name}" (${field.type})`);
      continue;
    }
    params[field.name] = coerce(field, value);
  }
  return params;
}

export function resolveValue(ref: { literal: string } | { param: string }, params: Record<string, unknown>): string {
  if ("literal" in ref) return ref.literal;
  const v = params[ref.param];
  if (v === undefined) throw new InputValidationError(`step references undeclared or missing param "${ref.param}"`);
  return String(v);
}
