/**
 * A small JSON Schema checker for agent outputs — enough of draft-07 to
 * enforce what agents declare (`type`, `properties`, `required`,
 * `additionalProperties: false`, `items`, `enum`, `const`, string / array
 * / number bounds, `anyOf` / `oneOf`, `nullable`). It is not a full
 * validator: unknown keywords are ignored rather than rejected, so a
 * schema never fails for using a feature this checker does not know.
 *
 * The runtime runs it on every parsed answer with a declared schema, also
 * when the executor constrained the output natively (a model can still
 * ignore the constraint). Errors are paths plus reasons the critic feeds
 * back to the model.
 */

import type { JsonSchema } from "./types";

export interface SchemaError {
  path: string;
  message: string;
}

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

function matchesType(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  if (t === "integer") return typeof v === "number" && Number.isInteger(v);
  if (t === "number") return typeof v === "number" && Number.isFinite(v);
  return actual === t;
}

export function validateSchema(value: unknown, schema: JsonSchema, path = "$", errors: SchemaError[] = [], depth = 0): SchemaError[] {
  if (depth > 32) return errors;
  const s = schema as Record<string, unknown>;

  if (s.nullable === true && value === null) return errors;
  if ("const" in s && JSON.stringify(value) !== JSON.stringify(s.const)) {
    errors.push({ path, message: `must equal ${JSON.stringify(s.const)}` });
    return errors;
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push({ path, message: `must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}` });
    return errors;
  }
  if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    const alts = (s.anyOf ?? s.oneOf) as JsonSchema[];
    const passing = alts.filter((alt) => validateSchema(value, alt, path, [], depth + 1).length === 0).length;
    if (passing === 0 || (Array.isArray(s.oneOf) && passing !== 1)) {
      errors.push({ path, message: Array.isArray(s.oneOf) ? `must match exactly one of ${alts.length} alternatives` : `must match one of ${alts.length} alternatives` });
      return errors;
    }
  }

  const types = typeof s.type === "string" ? [s.type] : Array.isArray(s.type) ? (s.type as string[]) : [];
  if (types.length && !types.some((t) => matchesType(value, t))) {
    errors.push({ path, message: `must be ${types.join(" or ")}, got ${typeOf(value)}` });
    return errors;
  }

  if (typeof value === "string") {
    if (typeof s.minLength === "number" && value.length < s.minLength) errors.push({ path, message: `must be at least ${s.minLength} characters` });
    if (typeof s.maxLength === "number" && value.length > s.maxLength) errors.push({ path, message: `must be at most ${s.maxLength} characters` });
    if (typeof s.pattern === "string") {
      try {
        if (!new RegExp(s.pattern, "u").test(value)) errors.push({ path, message: `must match ${s.pattern}` });
      } catch {
        /* why: bad pattern in the schema: ignore */
      }
    }
  } else if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) errors.push({ path, message: `must be ≥ ${s.minimum}` });
    if (typeof s.maximum === "number" && value > s.maximum) errors.push({ path, message: `must be ≤ ${s.maximum}` });
  } else if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) errors.push({ path, message: `must have at least ${s.minItems} items` });
    if (typeof s.maxItems === "number" && value.length > s.maxItems) errors.push({ path, message: `must have at most ${s.maxItems} items` });
    if (s.uniqueItems === true && new Set(value.map((x) => JSON.stringify(x))).size !== value.length) errors.push({ path, message: "items must be unique" });
    if (s.items && typeof s.items === "object" && !Array.isArray(s.items)) {
      value.forEach((item, i) => validateSchema(item, s.items as JsonSchema, `${path}[${i}]`, errors, depth + 1));
    }
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, JsonSchema>;
    for (const key of (s.required as string[] | undefined) ?? []) {
      if (!(key in obj)) errors.push({ path: `${path}.${key}`, message: "is required" });
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) validateSchema(obj[key], sub, `${path}.${key}`, errors, depth + 1);
    }
    if (s.additionalProperties === false) {
      for (const key of Object.keys(obj)) if (!(key in props)) errors.push({ path: `${path}.${key}`, message: "is not allowed" });
    } else if (s.additionalProperties && typeof s.additionalProperties === "object") {
      for (const key of Object.keys(obj)) if (!(key in props)) validateSchema(obj[key], s.additionalProperties as JsonSchema, `${path}.${key}`, errors, depth + 1);
    }
  }
  return errors;
}

/** One line the critic can feed back to the model. */
export function formatSchemaErrors(errors: SchemaError[], max = 5): string {
  const shown = errors.slice(0, max).map((e) => `${e.path} ${e.message}`);
  return shown.join("; ") + (errors.length > max ? `; +${errors.length - max} more` : "");
}
