// @vitest-environment node
/**
 * Plan W4.29 — the privacy policy matches the code: every route the privacy
 * ledger can record (src/ai/privacyLedger.ts and every module that records
 * through it) is mapped in PRIVACY.he.md (Hebrew, Amendment 13) and in
 * PRIVACY.md, by the exact name the ledger panel shows, and every ledger
 * category is named in both.
 *
 * A new route fails this test until it is documented: a new `reason` in the
 * ledger, a new module calling one of the ledger's recording APIs, or a new
 * category.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const DOCS = { "PRIVACY.he.md": read("PRIVACY.he.md"), "PRIVACY.md": read("PRIVACY.md") };

/** The modules that record into the ledger, each with the reasons it records. */
const RECORDERS: Record<string, (src: string) => string[]> = {
  // The rules, the endpoint routes and the recorders' fixed reasons; a
  // template reason is checked by its fixed start ("Plugin ", "Read aloud (").
  "src/ai/privacyLedger.ts": (src) => [
    ...[...src.matchAll(/reason: "([^"]+)"/g)].map((m) => m[1]),
    ...[...src.matchAll(/reason: `([^`$]+)\$\{/g)].map((m) => m[1]).filter((p) => !/^\s*$/.test(p)),
    /export const MONITORING_REASON = "([^"]+)"/.exec(src)![1],
  ],
  "src/research/clipper.ts": (src) => [/reason: "([^"]+)"/.exec(src)![1]],
  "src/agents/python/runner.ts": (src) => [/export const LEDGER_REASON = "([^"]+)"/.exec(src)![1]],
  "src/agents/network.ts": (src) => [/const reason = `([^`$]+)\$\{/.exec(src)![1]],
  "src/plugins/plantumlPolicy.ts": (src) => [/const REASON = "([^"]+)"/.exec(src)![1]],
  "src/ui/VoiceDictation.tsx": (src) => [...src.matchAll(/recordBrowserService\("[^"]+", "([^"]+)"\)/g)].map((m) => m[1]),
  // Records with MONITORING_REASON (above) and the desktop update check's fixed reason.
  "src/lib/sentryMonitor.ts": () => [],
  "src/desktop/updates.ts": () => [],
  "src/plugins/runtime/pluginHost.ts": () => [],
  // Network voices: the reason ("Read aloud (<lang>) …") is the ledger's own.
  "src/ai/tts.ts": () => [],
  // Jewish sources (plan W5.1): ledgerFetch with the ledger's own sefaria.org rule.
  "src/sources/sefaria/app.ts": () => [],
  // Calendar connections (plan W7.20): CalDAV and ICS, each with its own reason.
  "src/calendar/config.ts": (src) => [...src.matchAll(/\? "([^"]+)" : "([^"]+)"/g)].flatMap((m) => [m[1], m[2]]),
  // Standard.site publishing (W7.19): its fixed reason (the PDS and plc.directory rules are the ledger's).
  "src/publish/standardSite.ts": (src) => [/export const ATPROTO_REASON = "([^"]+)"/.exec(src)![1]],
  // Open sources (W7.24): each host under its source's reason; the gate itself records its callers' reasons.
  "src/sources/open/app.ts": (src) => [...src.matchAll(/reason: "([^"]+)"/g)].map((m) => m[1]),
  "src/sources/open/gate.ts": () => [],
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "__tests__" && name !== "node_modules") walk(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$|\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

const RECORDING_CALL = /\b(recordBrowserService|recordBlockedRequest|recordPluginRequest|recordAppUpdateCheck|recordSpeechVoice|recordSpeechRecognition|guardedFetch|ledgerFetch)\(/;

describe("PRIVACY.he.md / PRIVACY.md map every privacy-ledger route (plan W4.29)", () => {
  it("every module that records into the ledger is known here", () => {
    const callers = walk(join(ROOT, "src"))
      .filter((f) => RECORDING_CALL.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")))
      .map((f) => relative(ROOT, f))
      .filter((f) => f !== "src/ai/privacyLedger.ts");
    const unknown = callers.filter((f) => !(f in RECORDERS));
    expect(unknown, "a new module records into the privacy ledger: add it to RECORDERS and document its route").toEqual([]);
  });

  const reasons = [...new Set(Object.entries(RECORDERS).flatMap(([file, get]) => get(read(file))))];

  it("finds the routes (the extraction itself works)", () => {
    expect(reasons.length).toBeGreaterThan(25);
    for (const r of ["OpenAI", "Model download (Hugging Face)", "Error report (Sentry / GlitchTip), content removed", "Plugin ", "Agent tool "]) expect(reasons).toContain(r);
  });

  for (const [doc, text] of Object.entries(DOCS)) {
    it(`${doc}: every route by the name the ledger shows`, () => {
      const missing = reasons.filter((r) => !text.includes(`\`${r.trimEnd()}`));
      expect(missing).toEqual([]);
    });

    it(`${doc}: every ledger category`, () => {
      const union = /export type LedgerCategory = ([^;]+);/.exec(read("src/ai/privacyLedger.ts"))![1];
      const categories = [...union.matchAll(/"([\w-]+)"/g)].map((m) => m[1]);
      expect(categories.length).toBeGreaterThanOrEqual(9);
      expect(categories.filter((c) => !text.includes(`\`${c}\``))).toEqual([]);
    });
  }

  it("the Hebrew policy says it is not legal advice and asks for a lawyer's review", () => {
    expect(DOCS["PRIVACY.he.md"]).toContain("זה לא ייעוץ משפטי");
    expect(DOCS["PRIVACY.he.md"]).toContain("טל צריך לבקש מעורך דין");
    expect(DOCS["PRIVACY.he.md"]).toContain("הערכת השפעה על הפרטיות: שרת השיתוף (W4.8)");
  });
});
