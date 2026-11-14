/**
 * Conformance for structured output (plan W7.14): the same 5 schemas and
 * the same 50 Hebrew inputs on every engine. `runConformance` counts the
 * answers that are valid JSON for the schema (target ≥ 98 % per engine);
 * `runGateEval` scores the short tasks against their expected answers on
 * the built-in model and on the local model, and records the gate (≥ 90 %).
 *
 * In a real browser (Chrome 148+ with the built-in model, and Ollama or
 * web-llm): open the app, then in the devtools console
 *   const c = await import("/src/ai/structured/conformance.ts");
 *   await c.runConformanceInBrowser();   // and c.runGateEvalInBrowser()
 */
import type { JsonSchema } from "../../agents/types";
import { checkStructured, defaultEngines, type StructuredEngine } from "./index";
import { chromeVersion, saveGate, type GateResult } from "./gate";

export interface ConformanceSchema {
  id: string;
  /** A short task the zero-download tier may take. */
  short: boolean;
  instruction: string;
  schema: JsonSchema;
  /** Score one answer against the expected one (1 = right). */
  score: (got: unknown, want: unknown) => number;
}

const same = (a: unknown, b: unknown) => (JSON.stringify(a) === JSON.stringify(b) ? 1 : 0);
const overlap = (got: unknown, want: unknown) => {
  const g = new Set((Array.isArray(got) ? got : []).map((x) => String(x).replace(/^#/, "")));
  const w = Array.isArray(want) ? want.map(String) : [];
  return w.length ? w.filter((x) => g.has(x)).length / w.length : 1;
};

export const SCHEMAS: readonly ConformanceSchema[] = [
  {
    id: "category",
    short: true,
    instruction: "Classify the Hebrew note into one category.",
    schema: { type: "object", properties: { category: { type: "string", enum: ["work", "study", "home", "health", "money"] } }, required: ["category"] },
    score: (g, w) => same((g as { category?: string })?.category, w),
  },
  {
    id: "tags",
    short: true,
    instruction: "Give 1–4 tags for the Hebrew note: single Hebrew words, no #.",
    schema: { type: "object", properties: { tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4 } }, required: ["tags"] },
    score: (g, w) => overlap((g as { tags?: unknown })?.tags, w),
  },
  {
    id: "date",
    short: true,
    instruction: "Extract the date the Hebrew note mentions, as YYYY-MM-DD (the year is 2026), or null when there is none.",
    schema: { type: "object", properties: { date: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" } }, required: ["date"] },
    score: (g, w) => same((g as { date?: unknown })?.date ?? null, w),
  },
  {
    id: "sentiment",
    short: true,
    instruction: "Is the Hebrew note positive, negative or neutral?",
    schema: { type: "object", properties: { sentiment: { type: "string", enum: ["positive", "negative", "neutral"] } }, required: ["sentiment"] },
    score: (g, w) => same((g as { sentiment?: string })?.sentiment, w),
  },
  {
    id: "task",
    short: false,
    instruction: "Turn the Hebrew note into one task: a short Hebrew title, a priority 1–3 and whether it is done.",
    schema: {
      type: "object",
      properties: { title: { type: "string", minLength: 1 }, priority: { type: "integer", minimum: 1, maximum: 3 }, done: { type: "boolean" } },
      required: ["title", "priority", "done"],
    },
    score: (g, w) => same((g as { done?: boolean })?.done, (w as { done: boolean }).done),
  },
];

interface Input {
  text: string;
  want: Record<string, unknown>;
}

const SUBJECTS: Array<[string, string, string]> = [
  ["פגישה עם הצוות על התקציב", "work", "תקציב"],
  ["מבחן בסטטיסטיקה", "study", "מבחן"],
  ["לתקן את הברז במטבח", "home", "תיקון"],
  ["תור לרופאת שיניים", "health", "רופא"],
  ["לשלם את חשבון החשמל", "money", "חשבון"],
];
const DATES: Array<[string, string | null]> = [
  ["ב-3 במרץ", "2026-03-03"],
  ["ב-15.6", "2026-06-15"],
  ["ביום ראשון", null],
  ["ב-1 בדצמבר", "2026-12-01"],
  ["", null],
];
const MOODS: Array<[string, string, boolean]> = [
  ["הלך מצוין, סיימנו", "positive", true],
  ["היה מתסכל ולא הסתדר", "negative", false],
  ["", "neutral", false],
];

/** The 50 inputs: every subject × date phrase, with two moods each. */
export function conformanceInputs(): Input[] {
  const out: Input[] = [];
  for (let i = 0; i < 50; i++) {
    const [subject, category, tag] = SUBJECTS[i % 5]!;
    const [when, date] = DATES[Math.floor(i / 5) % 5]!;
    const [mood, sentiment, done] = MOODS[Math.floor(i / 25) === 0 ? i % 3 : (i + 1) % 3]!;
    const text = [subject, when, mood].filter(Boolean).join(" ") + ".";
    out.push({ text, want: { category, tags: [tag], date, sentiment, task: { done } } });
  }
  return out;
}

export interface ConformanceReport {
  engine: string;
  valid: number;
  total: number;
  /** valid / total */
  rate: number;
  invalid: Array<{ schema: string; input: number; error: string }>;
}

/** Every schema × every input on one engine: how many answers are valid for the schema. */
export async function runConformance(engine: StructuredEngine, inputs: Input[] = conformanceInputs(), schemas: readonly ConformanceSchema[] = SCHEMAS): Promise<ConformanceReport> {
  const r: ConformanceReport = { engine: engine.id, valid: 0, total: 0, rate: 0, invalid: [] };
  for (const s of schemas) {
    for (let i = 0; i < inputs.length; i++) {
      r.total++;
      let text = "";
      try {
        text = await engine.generate({ system: s.instruction, prompt: inputs[i]!.text, schema: s.schema, temperature: 0 });
      } catch (e) {
        r.invalid.push({ schema: s.id, input: i, error: `error: ${(e as Error)?.message ?? e}` });
        continue;
      }
      const c = checkStructured(text, s.schema);
      if (c.ok) r.valid++;
      else r.invalid.push({ schema: s.id, input: i, error: c.error });
    }
  }
  r.rate = r.total ? r.valid / r.total : 0;
  return r;
}

/** Score the short tasks (right answers, not only valid ones) on one engine, 0–1. */
export async function scoreShortTasks(engine: StructuredEngine, inputs: Input[] = conformanceInputs()): Promise<number> {
  let sum = 0;
  let n = 0;
  for (const s of SCHEMAS.filter((x) => x.short)) {
    for (const input of inputs) {
      n++;
      try {
        const c = checkStructured(await engine.generate({ system: s.instruction, prompt: input.text, schema: s.schema, temperature: 0 }), s.schema);
        if (c.ok) sum += s.score(c.value, input.want[s.id]);
      } catch {
        /* a failed call scores 0 */
      }
    }
  }
  return n ? sum / n : 0;
}

/** Measure the built-in model against the local one and record the gate. */
export async function runGateEval(builtin: StructuredEngine, local: StructuredEngine, localModel: string, ua?: string): Promise<GateResult> {
  const r: GateResult = { builtinScore: await scoreShortTasks(builtin), localScore: await scoreShortTasks(local), localModel, chromeVersion: chromeVersion(ua), at: new Date().toISOString() };
  saveGate(r);
  return r;
}

export async function runConformanceInBrowser(): Promise<ConformanceReport[]> {
  const out: ConformanceReport[] = [];
  for (const e of defaultEngines()) if (await e.available()) out.push(await runConformance(e));
  return out;
}

export async function runGateEvalInBrowser(localModel = "ollama"): Promise<GateResult | null> {
  const [builtin, ollama, webllm] = defaultEngines();
  const local = (await ollama!.available()) ? ollama! : webllm!;
  if (!(await builtin!.available()) || !(await local.available())) return null;
  return runGateEval(builtin!, local, localModel);
}
