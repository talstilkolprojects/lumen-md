/**
 * Eval of the app's direct prompts (K1): each PROMPTS entry with a realistic
 * message, against the model the eval runs on (`npm run eval:agents`).
 * LUMEN_EVAL_WIRING=1 (CI with the fake server) checks only that every
 * prompt gets an answer — the fake server can't judge language or format.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROMPTS } from "../../ai/prompts";
import { PROMPT_CASES } from "./promptCases";

const url = process.env.LUMEN_EVAL_OLLAMA_URL || "http://localhost:11434";
const model = process.env.LUMEN_EVAL_MODEL || "qwen2.5:7b";
const outDir = process.env.LUMEN_EVAL_OUT || "eval/results";
const wiring = process.env.LUMEN_EVAL_WIRING === "1";

describe(`prompt eval — ${model} @ ${url}`, () => {
  it("runs every prompt case and writes the report", async () => {
    const results: Array<{ id: string; status: "ok" | "failed"; checks: Array<{ name: string; ok: boolean }>; ms: number; error?: string }> = [];
    for (const c of PROMPT_CASES) {
      const started = Date.now();
      try {
        const res = await fetch(`${url}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, stream: false, options: { temperature: 0 }, messages: [{ role: "system", content: PROMPTS[c.prompt] }, { role: "user", content: c.user }] }),
        });
        const out = ((await res.json()) as { message?: { content?: string } }).message?.content ?? "";
        const checks = (wiring ? c.checks.filter((k) => k.name === "non-empty") : c.checks).map((k) => ({ name: k.name, ok: k.test(out, c.user) }));
        results.push({ id: c.id, status: "ok", checks, ms: Date.now() - started });
      } catch (e) {
        results.push({ id: c.id, status: "failed", checks: [], ms: Date.now() - started, error: (e as Error).message });
      }
      const r = results[results.length - 1];
      // hygiene-allow: progress output of a CLI eval run
      console.log(`${r.status === "ok" && r.checks.every((k) => k.ok) ? "pass" : "FAIL"}  ${c.id}  ${r.checks.filter((k) => !k.ok).map((k) => k.name).join(", ")}`);
    }
    const date = new Date().toISOString().slice(0, 10);
    const ver = (await fetch(`${url}/api/version`).then((r) => r.json()).catch(() => ({}))) as { lumen_fake?: boolean };
    const kind = wiring || ver.lumen_fake ? "wiring" : "model";
    const label = ver.lumen_fake ? "fake-ollama" : model;
    const slug = label.replace(/[^\w.-]+/g, "_");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `prompts-${date}-${slug}.json`), JSON.stringify({ model: label, kind, url, date, wiring, results }, null, 2));
    expect(results.every((r) => r.status === "ok")).toBe(true);
  }, 60 * 60 * 1000);
});
