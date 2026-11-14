/**
 * Plan W2.18 acceptance — "draw me" on a local 7B model: at least 80% of the
 * 20 requests (Hebrew and English, every editable diagram type) give a
 * valid diagram: one of the five editable types, accepted by the real
 * Mermaid parser, within the agent's retries. Not part of the normal run:
 *
 *   npm run eval:canvas-draw -- --model qwen2.5:7b [--url http://localhost:11434]
 *
 * Only on the local executor (Ollama), so it makes no request off the
 * machine. Writes eval/results/canvas-draw-<date>-<model>.json; prints only
 * counts and diagram types, never the model's text.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));

import { runAgent } from "../runtime";
import { drawAgent } from "../../canvas/drawAgent";
import { diagramKind } from "../../canvas/mermaidPrep";

export const DRAW_REQUESTS: Array<{ id: string; text: string; want: string }> = [
  { id: "he-order-flow", want: "flowchart", text: "תרשים זרימה של תהליך הזמנה: לקוח שולח בקשה, מנהל מאשר או דוחה, ואם אושר — משלוח" },
  { id: "he-onboarding", want: "flowchart", text: "תהליך קליטת עובד חדש: חוזה, ציוד, הדרכה, חונך, סיום שבוע ראשון" },
  { id: "he-bug-triage", want: "flowchart", text: "איך מטפלים בבאג: דיווח, שחזור, אם משוחזר — תיקון ובדיקה, אחרת סגירה" },
  { id: "en-deploy", want: "flowchart", text: "Deployment pipeline: commit, build, test, if tests pass deploy to staging, then production" },
  { id: "he-login-seq", want: "sequence", text: "תרשים רצף של התחברות: משתמש, דפדפן, שרת ומסד נתונים" },
  { id: "he-payment-seq", want: "sequence", text: "רצף תשלום: לקוח משלם באפליקציה, האפליקציה פונה לספק תשלומים, הספק מאשר והאפליקציה שולחת קבלה" },
  { id: "en-api-seq", want: "sequence", text: "Sequence diagram: the editor asks the local model for a summary, the model streams tokens back" },
  { id: "he-sync-seq", want: "sequence", text: "סנכרון בין שני מכשירים דרך שרת ממסר מוצפן" },
  { id: "he-library-class", want: "class", text: "תרשים מחלקות לספרייה: ספר, מחבר, השאלה, קורא, עם הקשרים ביניהם" },
  { id: "he-shop-class", want: "class", text: "מחלקות של חנות: מוצר, הזמנה, שורת הזמנה, לקוח" },
  { id: "en-notes-class", want: "class", text: "Class diagram of a notes app: Vault contains Notes, a Note has Tags and Links to other Notes" },
  { id: "he-school-class", want: "class", text: "מחלקות לבית ספר: תלמיד, מורה, כיתה, מקצוע וציון" },
  { id: "he-doc-state", want: "state", text: "תרשים מצבים של מסמך: טיוטה, בבדיקה, מאושר, פורסם, בארכיון" },
  { id: "he-order-state", want: "state", text: "מצבי הזמנה: חדשה, בתשלום, שולמה, נשלחה, נמסרה, או בוטלה" },
  { id: "en-player-state", want: "state", text: "State diagram of an audio player: stopped, playing, paused, buffering" },
  { id: "he-ticket-state", want: "state", text: "מחזור החיים של פנייה לתמיכה: פתוחה, בטיפול, ממתינה ללקוח, סגורה" },
  { id: "he-clinic-er", want: "er", text: "תרשים ER למרפאה: מטופל, רופא, תור, מרשם" },
  { id: "he-blog-er", want: "er", text: "מודל נתונים של בלוג: כותב, פוסט, תגובה, תגית" },
  { id: "en-reading-er", want: "er", text: "ER diagram for a reading app: Book, Author, Highlight, Note" },
  { id: "he-events-er", want: "er", text: "מודל נתונים לאירועים: אירוע, משתתף, הרשמה, מקום" },
];

const url = process.env.LUMEN_EVAL_OLLAMA_URL || "http://localhost:11434";
const model = process.env.LUMEN_EVAL_MODEL || "qwen2.5:7b";
const outDir = process.env.LUMEN_EVAL_OUT || "eval/results";
const enabled = process.env.LUMEN_EVAL_CANVAS === "1";

(enabled ? describe : describe.skip)(`canvas "draw me" eval — ${model} @ ${url}`, () => {
  it("≥ 80% of 20 requests give a valid editable diagram", async () => {
    const tags = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) }).catch((e: Error) => e);
    expect(tags instanceof Error ? `Ollama unreachable at ${url}: ${tags.message}` : "ok").toBe("ok");
    localStorage.setItem("lumen.ollama.baseUrl", url);
    localStorage.setItem("lumen.ollama.model", model);
    localStorage.setItem("lumen.ai.policy", "local-only");
    localStorage.setItem("lumen.ai.cache", "off");
    const results: Array<{ id: string; ok: boolean; kind: string | null; want: string; attempts: number; ms: number; error?: string }> = [];
    for (const r of DRAW_REQUESTS) {
      const t0 = Date.now();
      const run = await runAgent(drawAgent, { text: r.text }, { executor: "ollama", patch: { model } });
      const ok = run.status === "ok" && typeof run.output === "string";
      results.push({ id: r.id, ok, kind: ok ? diagramKind(run.output as string) : null, want: r.want, attempts: run.attempts, ms: Date.now() - t0, ...(ok ? {} : { error: run.errorCode ?? run.error }) });
      // hygiene-allow: progress output of a CLI eval run (counts only)
      console.log(`${ok ? "pass" : "FAIL"}  ${r.id}  ${results.at(-1)!.kind ?? "-"}  ${run.attempts} attempt(s)`);
    }
    const valid = results.filter((x) => x.ok).length;
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `canvas-draw-${new Date().toISOString().slice(0, 10)}-${model.replace(/[^\w.-]+/g, "_")}.json`);
    writeFileSync(file, JSON.stringify({ model, url, valid, total: results.length, rate: valid / results.length, results }, null, 2));
    // hygiene-allow: tells the person running the eval the score and where the report is
    console.log(`\nvalid: ${valid}/${results.length} (${Math.round((100 * valid) / results.length)}%) — ${file}`);
    expect(valid / results.length).toBeGreaterThanOrEqual(0.8);
  }, 60 * 60 * 1000);
});
