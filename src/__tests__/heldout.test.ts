// @vitest-environment node
/**
 * Plan W6.17 — the held-out evaluator (scripts/heldout.mjs): keys and
 * encryption, the keyed split, commitments, rotation, the contamination
 * check, the evaluator's log, the scoring rules, the manifest's sources and
 * licences, and the command end to end on synthetic pools (made up here,
 * never a real item) against the fake Ollama. The end-to-end case also
 * checks that no item text reaches the output, the results or the log.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANARY_PREFIX,
  addedLines,
  buildIndex,
  bundleHeader,
  callFromMessage,
  canaryGuid,
  commitment,
  decrypt,
  deriveSecrets,
  encrypt,
  findCanaries,
  generateKey,
  grammarLabel,
  logEntry,
  mcqLetter,
  normalize,
  parseSlots,
  prf,
  qaScore,
  rankPool,
  recipientOf,
  rotate,
  scanDocument,
  secretForms,
  setDigest,
  take,
  tokenF1,
  toolCallScore,
  verifyLog,
  yesNo,
  // @ts-expect-error — plain .mjs script without type declarations
} from "../../scripts/lib/heldout.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { SETS, SOURCES, drawAll, toolsOf } from "../../scripts/heldout/sets.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { STEPS, availability, heldoutMetrics, selectSteps, declaredMinutes } from "../../scripts/lib/modelsDay.mjs";

type Row = Record<string, unknown> & { id: string };
type SetDef = { id: string; size: number; source: string; rows: string[]; prefix: string; fields: (it: unknown) => string[] };
type Item = { id: string } & Record<string, unknown>;
const sets = SETS as SetDef[];
const tmp = () => mkdtempSync(join(tmpdir(), "heldout-"));
const manifest = JSON.parse(readFileSync("eval/heldout/manifest.json", "utf8")) as {
  recipient: string | null;
  sets: Array<{ id: string; size: number; source: string; license: string; canary: string; sealed: unknown }>;
};

// ── synthetic pools (made up for the test; no real item anywhere) ─────────

const WORDS = "אבן גשר דלת הר ורד זית חלון טל ים כוכב לחם מים נהר סלע עץ פרח צל קיר רוח שמש תות ענן שביל גן חול אור ספר עיר כפר דרך שדה בית מגדל נמל אי חוף מדבר יער".split(" ");
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const r = rng(42);
const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
const sentence = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(" ");

function pools(): Record<string, Row[]> {
  const mkqa = Array.from({ length: 700 }, (_, i) => ({ id: String(1000 + i), he_query: `${sentence(4 + (i % 4))}?`, en_query: `question ${i}?`, answers_he: [{ type: i % 7 ? "entity" : "number", text: i % 7 ? pick(WORDS) : String(i), aliases: [] }], answers_en: [{ type: "entity", text: `answer ${i}`, aliases: [] }] }));
  const judg = (sp: number, gr: number) => [0, 1, 2].map((w) => ({ worker_id: String(w), spelling_score: sp, grammar_score: gr, intent_score: 1, slots_score: 1, language_identification: 1 }));
  const intents = ["alarm_set", "alarm_query", "weather_query", "music_play", "calendar_set", "iot_cleaning"];
  const slotFor: Record<string, string[]> = { alarm_set: ["time", "date"], alarm_query: ["time"], weather_query: ["place_name", "date"], music_play: ["artist_name"], calendar_set: ["event_name", "date"], iot_cleaning: [] };
  const massive = (n: number, part: string) =>
    Array.from({ length: n }, (_, i) => {
      const intent = intents[i % intents.length];
      const slots = slotFor[intent].map((t) => `[${t} : ${pick(WORDS)}]`).join(" ");
      return { id: `${part}${i}`, scenario: intent.split("_")[0], intent, utt: `${sentence(5)} ${i}`, annot_utt: `${sentence(3)} ${slots}`.trim(), judgments: i % 2 ? judg(2, 4) : judg(0, 2) };
    });
  const opt = (k: string) => [0, 1, 2, 3].map((j) => `${k} ${j} ${pick(WORDS)}`);
  const gmmlu = Array.from({ length: 260 }, (_, i) => ({ id: `s${i}`, subject: "test", he: { question: `${sentence(9)} ${i}?`, options: opt("א") }, en: { question: `English question number ${i}?`, options: opt("o") }, answer: "ABCD"[i % 4] }));
  const fleurs = Array.from({ length: 260 }, (_, i) => ({ id: `fleurs-train-${i}`, text: sentence(14), durationMs: 3000 + (i % 10) * 1000, file: `${i}.wav` }));
  return { mkqa, "massive-validation": massive(700, "v"), "massive-test": massive(500, "t"), "global-mmlu": gmmlu, fleurs };
}

function writeRows(dir: string, p: Record<string, Row[]>) {
  for (const [name, rows] of Object.entries(p)) writeFileSync(join(dir, `${name}.jsonl`), [JSON.stringify({ meta: { source: name, revision: `rev-${name}`, files: { [`${name}.parquet`]: "0".repeat(64) }, license: "test" } }), ...rows.map((x) => JSON.stringify(x))].join("\n") + "\n");
}

// ── keys and bundles ──────────────────────────────────────────────────────

describe("keys and bundles", () => {
  it("encrypts to the evaluator's public key; only its secret opens the bundle, and any changed byte fails", () => {
    const k = generateKey();
    expect(recipientOf(k.secret)).toBe(k.recipient);
    const value = { items: [{ id: "x", text: "משפט סודי" }] };
    const b: Buffer = encrypt(value, k.recipient, "t");
    expect(decrypt(b, k.secret)).toEqual(value);
    expect(b.toString("utf8")).not.toContain("משפט סודי");
    expect(JSON.stringify(bundleHeader(b))).not.toContain("משפט");
    expect(() => decrypt(b, generateKey().secret)).toThrow(/another key/);
    const bad = Buffer.from(b);
    bad[bad.length - 20] ^= 1;
    expect(() => decrypt(bad, k.secret)).toThrow();
    expect(() => recipientOf("not a key")).toThrow(/not a held-out key/);
  });

  it("derives a split secret and a commit secret that differ per key", () => {
    const a = deriveSecrets(generateKey().secret);
    const b = deriveSecrets(generateKey().secret);
    expect(a.split.equals(a.commit)).toBe(false);
    expect(a.split.equals(b.split)).toBe(false);
  });
});

// ── the keyed split, commitments, rotation ────────────────────────────────

describe("the keyed split", () => {
  const pool = Array.from({ length: 200 }, (_, i) => ({ id: `p${i}` }));
  it("is the same for the same key and different for another key", () => {
    const k1 = deriveSecrets(generateKey().secret).split;
    const k2 = deriveSecrets(generateKey().secret).split;
    const ids = (k: Buffer) => (rankPool(pool, k, "s") as Row[]).slice(0, 20).map((x) => x.id);
    expect(ids(k1)).toEqual(ids(k1));
    expect(ids(k1)).not.toEqual(ids(k2));
    expect(() => take(pool, 201)).toThrow(/only 200/);
    expect((take(pool, 3, { exclude: new Set(["p0"]), accept: (x: Row) => x.id !== "p1" }) as Row[]).map((x) => x.id)).toEqual(["p2", "p3", "p4"]);
  });

  it("draws every set at its size, and the sets sharing MKQA never share an item", () => {
    const s = deriveSecrets(generateKey().secret);
    const drawn = drawAll(sets, pools(), s) as Record<string, Item[]>;
    for (const set of sets) expect(drawn[set.id].length, set.id).toBe(set.size);
    const qa = new Set(drawn["qa-he"].map((x) => x.id.replace(/^mkqa-/, "")));
    expect(drawn["ocr-he"].some((x) => qa.has(x.id.replace(/^ocr-/, "")))).toBe(false);
    const g = drawn["grammar-he"];
    expect(g.filter((x) => x.flawed).length).toBe(150);
    const tc = drawn["toolcall-he"][0] as Item & { tools: Array<{ name: string }>; intent: string };
    expect(tc.tools.some((t) => t.name === tc.intent)).toBe(true);
    expect(tc.tools.length).toBeGreaterThan(4);
  });

  it("commits to items without revealing them, and rotates 20 % without reusing a retired item", () => {
    const s = deriveSecrets(generateKey().secret);
    const items = Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, text: `t${i}` }));
    const cs = items.map((it) => commitment(s.commit, "x", it));
    expect(cs[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(commitment(deriveSecrets(generateKey().secret).commit, "x", items[0])).not.toBe(cs[0]);
    expect(setDigest([...cs].reverse())).toBe(setDigest(cs));
    const fresh = Array.from({ length: 30 }, (_, i) => ({ id: `f${i}`, text: `f${i}` }));
    const r1 = rotate(items, fresh, { splitKey: s.split, version: 2 });
    expect(r1.items.length).toBe(50);
    expect(r1.retired.length).toBe(10);
    expect(r1.items.filter((x: Row) => x.id.startsWith("f")).length).toBe(10);
    const r2 = rotate(r1.items, fresh, { splitKey: s.split, version: 3, used: new Set([...r1.retired, ...items.map((x) => x.id)]) });
    expect(r2.items.some((x: Row) => r1.retired.includes(x.id))).toBe(false);
  });
});

// ── the contamination check ───────────────────────────────────────────────

describe("the contamination check", () => {
  const long = "השמש זרחה מעל ההרים הירוקים והציפורים שרו שירים עליזים בבוקר הקריר של תחילת האביב כשהילדים יצאו לשחק בשדה הרחב והגדול";
  const idx = buildIndex([
    { id: "long", text: long },
    { id: "short", text: "תעיר אותי מחר בשבע בבוקר בבקשה" },
    { id: "tiny", text: "כן" },
  ]);
  it("finds an item copied with nikud, other punctuation and line breaks", () => {
    const copy = `פתיחה. ${long.replace("השמש", "הַשֶּׁמֶשׁ").replace(/ /g, ",\n")} — סוף`;
    expect(scanDocument(idx, copy)).toEqual([{ id: "long", why: "13-gram" }]);
    expect(normalize("הַשֶּׁמֶשׁ־זרחה")).toBe("השמש זרחה");
  });
  it("finds half of a long item's 8-grams, and a short item whole; ignores ordinary text", () => {
    const words = long.split(" ");
    const half = `${words.slice(0, 12).join(" ")} ומשהו אחר לגמרי ${words.slice(8, 20).join(" ")}`;
    expect(words.length).toBe(20);
    expect(scanDocument(idx, half).map((h: { id: string }) => h.id)).toEqual(["long"]);
    expect(scanDocument(idx, "אז תעיר אותי מחר בשבע בבוקר בבקשה, תודה").map((h: { id: string }) => h.id)).toEqual(["short"]);
    expect(scanDocument(idx, "תעיר אותי מחר בשמונה ושמש זרחה מעל הים")).toEqual([]);
    expect(idx.tooShort).toBe(1);
  });
  it("finds canaries and keys, and reads only the added lines of a diff", () => {
    const c = `${CANARY_PREFIX}1234-abcd`;
    expect(canaryGuid(c)).toBe("1234-abcd");
    expect(findCanaries(`x ${"1234-abcd"} y`, [{ set: "a", guid: "1234-abcd" }])).toHaveLength(1);
    expect(addedLines("+++ b/f\n+new line\n-old line\n context")).toBe("new line");
    const k = generateKey();
    expect(secretForms(k.secret).some((f: string) => `x${k.secret}y`.includes(f))).toBe(true);
  });
});

// ── the log ───────────────────────────────────────────────────────────────

describe("the evaluator's log", () => {
  it("chains entries so a changed or removed entry is caught", () => {
    let text = "";
    for (const who of ["tal@mac", "nightly@host", "tal@mac"]) text += logEntry(text, { at: "2026-11-12T20:00:00Z", requester: who, action: "score", sets: [{ id: "qa-he", version: 1 }] }) + "\n";
    expect(verifyLog(text)).toEqual([]);
    const lines = text.trim().split("\n");
    expect(verifyLog(lines[0] + "\n" + lines[2])[0]).toMatch(/chain is broken/);
    expect(verifyLog(text.replace("nightly@host", "someone@else"))[0]).toMatch(/changed/);
    expect(JSON.parse(lines[2])).toMatchObject({ seq: 3, requester: "tal@mac" });
  });
});

// ── scoring rules ─────────────────────────────────────────────────────────

describe("scoring rules", () => {
  it("QA: alias as whole words (prefix letters allowed), numbers, yes/no; token F1", () => {
    expect(qaScore("בפריז", [{ type: "entity", text: "פריז", aliases: [] }]).correct).toBe(true);
    expect(qaScore("Paris, France", [{ type: "entity", text: "פריז", aliases: ["Paris"] }]).correct).toBe(true);
    expect(qaScore("פריזאי", [{ type: "entity", text: "פריז", aliases: [] }]).correct).toBe(false);
    expect(qaScore("בערך 1,200 מטר", [{ type: "number_with_unit", text: "1200 מטר", aliases: [] }]).correct).toBe(true);
    expect(qaScore("לא, הוא לא", [{ type: "binary", text: "no", aliases: [] }]).correct).toBe(true);
    expect(tokenF1("הנשיא הראשון", "נשיא ראשון")).toBe(1);
  });
  it("multiple choice, MASSIVE slots, tool calls and grammar labels", () => {
    expect(mcqLetter("B")).toBe("B");
    expect(mcqLetter("(c) because")).toBe("C");
    expect(mcqLetter("התשובה היא D.")).toBe("D");
    expect(mcqLetter("אין לי מושג")).toBe(null);
    expect(parseSlots("תעיר אותי [time : בשבע] [date : מחר]")).toEqual([{ type: "time", value: "בשבע" }, { type: "date", value: "מחר" }]);
    const tools = [{ name: "alarm_set", params: ["date", "time"] }, { name: "weather_query", params: ["date"] }];
    const exp = { intent: "alarm_set", slots: [{ type: "time", value: "בשבע" }, { type: "date", value: "מחר" }] };
    expect(toolCallScore({ name: "alarm_set", arguments: { time: "בשבע", date: "מחר" } }, exp, tools)).toMatchObject({ valid: true, intent: true, slotTp: 2, slotFp: 0, slotFn: 0 });
    expect(toolCallScore({ name: "alarm_set", arguments: { hour: "7" } }, exp, tools)).toMatchObject({ valid: false, intent: true });
    expect(toolCallScore(null, exp, tools)).toMatchObject({ valid: false, slotFn: 2 });
    expect(callFromMessage({ content: 'sure: {"name":"weather_query","arguments":{"date":"מחר"}}' })).toEqual({ name: "weather_query", arguments: { date: "מחר" } });
    expect(callFromMessage({ tool_calls: [{ function: { name: "alarm_set", arguments: '{"time":"7"}' } }] })).toEqual({ name: "alarm_set", arguments: { time: "7" } });
    const j = (sp: number, gr: number) => ({ spelling_score: sp, grammar_score: gr });
    expect(grammarLabel([j(0, 3), j(1, 3), j(2, 4)])).toBe("flawed");
    expect(grammarLabel([j(2, 3), j(2, 4), j(2, 4)])).toBe("clean");
    expect(grammarLabel([j(2, 2), j(2, 4), j(1, 4)])).toBe(null);
    expect(yesNo("כן, יש שגיאה")).toBe(true);
    expect(prf([{ pred: true, gold: true }, { pred: false, gold: true }, { pred: true, gold: false }, { pred: false, gold: false }])).toMatchObject({ precision: 0.5, recall: 0.5, f1: 0.5, accuracy: 0.5 });
    expect(toolsOf([{ id: "1", intent: "alarm_set", annot_utt: "[time : 7]" }, { id: "2", intent: "alarm_set", annot_utt: "[date : מחר]" }])).toEqual({ alarm_set: ["date", "time"] });
  });
});

// ── the manifest ──────────────────────────────────────────────────────────

describe("the manifest", () => {
  it("lists every set once, with its size, an open licence and its own canary", () => {
    expect(manifest.sets.map((s) => s.id)).toEqual(sets.map((s) => s.id));
    for (const s of manifest.sets) {
      expect(s.size, s.id).toBe(sets.find((x) => x.id === s.id)!.size);
      expect(["CC-BY-4.0", "CC-BY-SA-3.0", "Apache-2.0"], s.id).toContain(s.license);
      expect(s.canary.startsWith(CANARY_PREFIX), s.id).toBe(true);
    }
    expect(new Set(manifest.sets.map((s) => canaryGuid(s.canary))).size).toBe(manifest.sets.length);
    expect(manifest.sets.reduce((n, s) => n + s.size, 0)).toBe(1420);
    for (const src of ["mkqa", "massive", "global-mmlu", "fleurs"]) expect(Object.keys(SOURCES).includes(src), src).toBe(true);
  });

  it("uses no pool of a dev set: the golden sets and probes never name these sources, and sample other FLEURS splits", () => {
    const golden = "eval/golden";
    const texts = readdirSync(golden, { recursive: true, encoding: "utf8" })
      .filter((f) => /\.(md|json)$/.test(f))
      .map((f) => readFileSync(join(golden, f), "utf8"));
    for (const name of ["MKQA", "ml-mkqa", "MASSIVE", "AmazonScience/massive", "Global-MMLU"]) expect(texts.some((t) => t.includes(name)), name).toBe(false);
    const asr = readFileSync(join(golden, "asr-he/SOURCES.md"), "utf8");
    expect(asr).toContain("FLEURS he_il, test split");
    expect(asr).not.toMatch(/train split/);
    expect(readFileSync("scripts/asr/fleurs_spike.py", "utf8")).toContain("validation");
  });

  it("holds no key and no item: only the public half of a key, ever", () => {
    const text = readFileSync("eval/heldout/manifest.json", "utf8");
    expect(text).not.toContain("LUMEN-HELDOUT-SECRET-KEY");
    expect(manifest.recipient === null || manifest.recipient.startsWith("lumen-heldout-1")).toBe(true);
  });
});

// ── models:day ────────────────────────────────────────────────────────────

describe("models:day", () => {
  type Step = { id: string; optional?: boolean; minutes: number; requires: { script?: string }; blockedUnless?: { option: string } };
  const step = (STEPS as Step[]).find((s) => s.id === "heldout")!;
  it("has a held-out step that waits for the evaluator key and stays out of the default 3-hour run", () => {
    expect(step.optional).toBe(true);
    const scripts = { heldout: "node scripts/heldout.mjs" };
    expect(availability(step, { scripts, options: {} })).toMatchObject({ ok: false, status: "blocked" });
    expect(availability(step, { scripts, options: { heldoutKey: true } })).toEqual({ ok: true });
    expect(declaredMinutes(selectSteps(STEPS))).toBeLessThanOrEqual(180);
    expect((selectSteps(STEPS, { withOptional: ["heldout"] }) as Step[]).some((s) => s.id === "heldout")).toBe(true);
  });
  it("reads the evaluator's aggregates and the scan verdict", () => {
    const dir = tmp();
    writeFileSync(join(dir, "scan.json"), JSON.stringify({ verdict: "clean", canaryHits: [], items: [], keyLeaks: [], ngram: "on" }));
    writeFileSync(join(dir, "heldout-2026-11-12T20-00.json"), JSON.stringify({ kind: "model", sets: { "toolcall-he": { version: 1, locked: true, n: 300, models: { "qwen2.5:7b": { valid: 0.96, share: 0.96 }, "gemma3:12b": { valid: 0.91, share: 0.91 } } }, "asr-he": { status: "unavailable" } }, log: { seq: 4, requester: "nightly@host", at: "t", hash: "h" } }));
    const m = heldoutMetrics(dir);
    expect(m).toMatchObject({ heldout: true, kind: "model", share: 0.91, scan: { verdict: "clean", findings: 0 }, log: { requester: "nightly@host" } });
    expect(m.sets["asr-he"]).toEqual({ status: "unavailable" });
  });
});

// ── the command, end to end ───────────────────────────────────────────────

describe("the command, end to end on synthetic pools", () => {
  let fake: ChildProcess | null = null;
  afterAll(() => {
    fake?.kill();
  });
  const freePort = () =>
    new Promise<number>((done) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const port = (s.address() as { port: number }).port;
        s.close(() => done(port));
      });
    });

  it("builds sealed bundles, scores against the fake Ollama with aggregates only, logs who asked, and the scan catches a planted item", async () => {
    const root = tmp();
    const rowsDir = join(root, "rows");
    const store = join(root, "store");
    mkdirSync(rowsDir);
    const p = pools();
    writeRows(rowsDir, p);
    const k = generateKey();
    const env = { ...process.env, LUMEN_HELDOUT_KEY: k.secret, LUMEN_HELDOUT_DIR: store, LUMEN_HELDOUT_REQUESTER: "test@ci", HOME: root };
    const cli = (args: string[]) => spawnSync(process.execPath, ["scripts/heldout.mjs", ...args], { encoding: "utf8", env, timeout: 120_000 });

    const build = cli(["build", "--from-rows", rowsDir]);
    expect(build.status, build.stderr).toBe(0);
    expect(build.stdout).toContain("qa-he: 300 items, v1");
    for (const s of sets) expect(existsSync(join(store, `${s.id}.lho`)), s.id).toBe(true);
    expect(readFileSync(join(store, "qa-he.lho")).toString("utf8")).not.toContain(String(p.mkqa[0].he_query).slice(0, 8));

    const port = await freePort();
    fake = spawn(process.execPath, ["--experimental-strip-types", "scripts/fake-ollama.mjs", "--port", String(port)], { stdio: "ignore" });
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${url}/api/version`).then((r) => r.ok, () => false)) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    const out = join(root, "results");
    const run = cli(["run", "--models", "qwen2.5:7b", "--url", url, "--out", out]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("WIRING RUN");
    const file = readdirSync(out).find((f) => f.startsWith("heldout-"))!;
    const res = JSON.parse(readFileSync(join(out, file), "utf8"));
    expect(res).toMatchObject({ kind: "wiring", requester: "test@ci", log: { seq: 2, requester: "test@ci" } });
    expect(res.sets["qa-he"].models["qwen2.5:7b"].n).toBe(300);
    expect(res.sets["toolcall-he"].models["qwen2.5:7b"]).toHaveProperty("valid");
    expect(res.sets["asr-he"].engine.status).toBe("unavailable");
    expect(res.sets["ocr-he"].engine.status).toBe("unavailable");

    // No item text anywhere the authors can read: output, results, log.
    const log = readFileSync(join(store, "log.jsonl"), "utf8");
    const seen = [build.stdout, build.stderr, run.stdout, run.stderr, JSON.stringify(res), log].join("\n");
    const texts = [...p.mkqa.slice(0, 50).map((x) => x.he_query), ...p["massive-test"].slice(0, 50).map((x) => x.utt), ...p["global-mmlu"].slice(0, 20).map((x) => (x.he as { question: string }).question), ...p.fleurs.slice(0, 20).map((x) => x.text)] as string[];
    for (const t of texts) expect(seen.includes(t), "an item reached the output").toBe(false);
    const logged = cli(["log", "--verify"]);
    expect(logged.stdout).toContain("2 entries, chain intact");
    expect(cli(["log"]).stdout).toMatch(/#2 \S+ score by test@ci/);

    // The scan: clean repo, then a planted held-out item and a planted canary.
    const plant = join(root, "plant");
    mkdirSync(plant);
    writeFileSync(join(plant, "notes.md"), "nothing held out here\n");
    const clean = cli(["scan", "--require-key", "--paths", plant, "--out", join(root, "scan.json")]);
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
    expect(clean.stdout).toContain("clean");
    // the item a set really holds (from the bundle, as the evaluator sees it)
    const bundle = decrypt(readFileSync(join(store, "asr-he.lho")), k.secret) as { items: Array<{ text: string }> };
    writeFileSync(join(plant, "prompt.txt"), `few-shot example: ${bundle.items[0].text}\n${manifest.sets[0].canary}\n`);
    const dirty = cli(["scan", "--require-key", "--paths", plant, "--out", join(root, "scan2.json")]);
    expect(dirty.status).toBe(1);
    const rep = JSON.parse(readFileSync(join(root, "scan2.json"), "utf8"));
    expect(rep.verdict).toBe("contaminated");
    expect(rep.items.some((h: { item: string }) => h.item.startsWith("asr-he:"))).toBe(true);
    expect(rep.canaryHits).toEqual([{ in: join(plant, "prompt.txt"), set: "qa-he" }]);
    expect(dirty.stdout).not.toContain(bundle.items[0].text);
    // without the key the scan still finds canaries, and says the n-gram check was skipped
    const nokey = spawnSync(process.execPath, ["scripts/heldout.mjs", "scan", "--paths", plant], { encoding: "utf8", env: { ...env, LUMEN_HELDOUT_KEY: "" } });
    expect(nokey.status).toBe(1);
    expect(nokey.stdout).toContain("skipped: no key");
    expect(spawnSync(process.execPath, ["scripts/heldout.mjs", "run"], { encoding: "utf8", env: { ...env, LUMEN_HELDOUT_KEY: "" } }).status).toBe(2);
  }, 240_000);
});
