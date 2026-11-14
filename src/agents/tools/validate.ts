/**
 * Validation tools and validators — the deterministic checks that decide
 * whether a model's answer can touch the document. They are exposed to the
 * model as tools (so it can check its own draft) and used by the runtime as
 * validators after the final answer.
 */

import { defineTool, requireString } from "./define";
import { extractJsonObject } from "../protocol";
import type { ValidationResult } from "../types";

export interface JsonCheck {
  ok: boolean;
  error?: string;
  missing?: string[];
}

/** Parse JSON (fences and prose around it tolerated); optionally require top-level keys. */
export function checkJson(text: string, requiredKeys: string[] = []): JsonCheck & { value?: unknown } {
  const candidate = extractJsonObject(text) ?? text.trim();
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${(e as Error).message}` };
  }
  if (requiredKeys.length) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "Expected a JSON object", missing: requiredKeys, value };
    }
    const missing = requiredKeys.filter((k) => !(k in (value as Record<string, unknown>)));
    if (missing.length) return { ok: false, error: `Missing keys: ${missing.join(", ")}`, missing, value };
  }
  return { ok: true, value };
}

export const validateJsonTool = defineTool<{ text: string; requiredKeys?: string[] }, JsonCheck>({
  name: "validate_json",
  description: "Check that text is valid JSON, optionally with required top-level keys. Use it on your draft before answering.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", minLength: 1 },
      requiredKeys: { type: "array", items: { type: "string" } },
    },
    required: ["text"],
    additionalProperties: false,
  },
  run: async (args) => {
    const keys = Array.isArray(args.requiredKeys) ? args.requiredKeys.filter((k) => typeof k === "string") : [];
    const r = checkJson(requireString(args, "text"), keys);
    return { ok: r.ok, ...(r.error ? { error: r.error } : {}), ...(r.missing ? { missing: r.missing } : {}) };
  },
});

export interface MermaidCheck {
  ok: boolean;
  error?: string;
  diagramType?: string;
}

/** Strip a ```mermaid fence if present. */
export function stripMermaidFence(code: string): string {
  return code
    .replace(/^\s*```\s*mermaid\s*\n?/i, "")
    .replace(/^\s*```\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}

/** Compile a Mermaid diagram with the real parser (loaded on demand). */
export async function checkMermaid(code: string): Promise<MermaidCheck> {
  const src = stripMermaidFence(code);
  if (!src) return { ok: false, error: "Empty diagram" };
  try {
    const mermaid = (await import("mermaid")).default;
    const r = await mermaid.parse(src, { suppressErrors: false });
    return { ok: true, ...(r && typeof r === "object" && "diagramType" in r ? { diagramType: String(r.diagramType) } : {}) };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    return { ok: false, error: msg.split("\n").slice(0, 4).join("\n").slice(0, 600) };
  }
}

export const validateMermaidTool = defineTool<{ code: string }, MermaidCheck>({
  name: "validate_mermaid",
  description: "Compile a Mermaid diagram and return the parser error if it is invalid. Always check your diagram before answering.",
  parameters: { type: "object", properties: { code: { type: "string", minLength: 1 } }, required: ["code"], additionalProperties: false },
  run: async (args) => checkMermaid(requireString(args, "code")),
});

export interface EChartsCheck {
  ok: boolean;
  error?: string;
  seriesTypes?: string[];
}

const CARTESIAN = new Set(["line", "bar", "scatter", "effectScatter", "candlestick", "boxplot", "heatmap"]);

/** Structural check of an ECharts option: series with types, axes for cartesian charts. */
export function checkECharts(text: string): EChartsCheck {
  const j = checkJson(text);
  if (!j.ok) return { ok: false, error: j.error };
  const opt = j.value as Record<string, unknown>;
  if (!opt || typeof opt !== "object" || Array.isArray(opt)) return { ok: false, error: "Expected an ECharts option object" };
  const series = opt.series;
  const list = Array.isArray(series) ? series : series && typeof series === "object" ? [series] : [];
  if (!list.length) return { ok: false, error: "`series` must be a non-empty array" };
  const types: string[] = [];
  for (const s of list) {
    if (!s || typeof s !== "object") return { ok: false, error: "Each series must be an object" };
    const type = (s as Record<string, unknown>).type;
    if (typeof type !== "string" || !type) return { ok: false, error: "Each series needs a string `type` (bar, line, pie…)" };
    const data = (s as Record<string, unknown>).data;
    if (!Array.isArray(data) || data.length === 0) return { ok: false, error: `Series "${type}" has no data` };
    types.push(type);
  }
  if (types.some((t) => CARTESIAN.has(t)) && !("xAxis" in opt) && !("yAxis" in opt) && !("dataset" in opt)) {
    return { ok: false, error: "Cartesian series (bar/line/scatter) need `xAxis` and `yAxis`", seriesTypes: types };
  }
  return { ok: true, seriesTypes: types };
}

export const validateEChartsTool = defineTool<{ option: string }, EChartsCheck>({
  name: "validate_echarts",
  description: "Check an ECharts option JSON: non-empty series with types and data, axes for bar/line charts.",
  parameters: { type: "object", properties: { option: { type: "string", minLength: 1 } }, required: ["option"], additionalProperties: false },
  run: async (args) => checkECharts(requireString(args, "option")),
});

export const VALIDATE_TOOLS = [validateJsonTool, validateMermaidTool, validateEChartsTool];

/* ── Validators for the runtime (same checks, ValidationResult shape) ── */

export function jsonValidator(requiredKeys: string[] = []) {
  return {
    name: "json",
    check: (output: unknown): ValidationResult => {
      const text = typeof output === "string" ? output : JSON.stringify(output);
      const r = checkJson(text, requiredKeys);
      return r.ok ? { ok: true } : { ok: false, reason: r.error ?? "invalid JSON", hint: "Reply with JSON only." };
    },
  };
}

export const mermaidValidator = {
  name: "mermaid",
  check: async (output: unknown): Promise<ValidationResult> => {
    const r = await checkMermaid(String(output ?? ""));
    return r.ok ? { ok: true } : { ok: false, reason: r.error ?? "invalid Mermaid", hint: "Fix the Mermaid syntax error and return only the diagram." };
  },
};

export const echartsValidator = {
  name: "echarts",
  check: (output: unknown): ValidationResult => {
    const r = checkECharts(typeof output === "string" ? output : JSON.stringify(output));
    return r.ok ? { ok: true } : { ok: false, reason: r.error ?? "invalid ECharts option", hint: "Return a complete ECharts option as JSON." };
  },
};

export function nonEmptyValidator(minChars = 1) {
  return {
    name: "non-empty",
    check: (output: unknown): ValidationResult => {
      const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
      return text.trim().length >= minChars ? { ok: true } : { ok: false, reason: "empty answer" };
    },
  };
}
