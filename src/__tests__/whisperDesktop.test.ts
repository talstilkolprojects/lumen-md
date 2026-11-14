/**
 * Plan W1.17 — ivrit.ai Hebrew Whisper on the desktop: the model seam
 * (nothing offered until the owner pins the ggml file), the Tauri calls,
 * the engine choice for files, and the long-file transcript (sentences with
 * times linked to the audio).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { desktopWhisperStatus, downloadUrl, isPinned, toPcm16, transcribeDesktop, WHISPER_GGML, type GgmlModel, type Invoke } from "../ai/dictation/whisperDesktop";
import { clock, sentencesOf, timedChunks, timeFragment, transcriptMarkdown } from "../ai/dictation/longform";
import { chooseEngine, OZEN_LICENSE_APPROVED, type EngineContext, type EngineId } from "../ai/dictation/engines";
import { attachmentName } from "../ui/TranscribeFile";
import { t } from "../i18n";
import { readLocale } from "../../scripts/lib/i18n-files.mjs";

const PINNED: GgmlModel = {
  ...WHISPER_GGML,
  repo: "example-owner/whisper-large-v3-turbo-ggml",
  revision: "c".repeat(40),
  file: "ggml-model.bin",
  bytes: 1_624_555_275,
  sha256: "d".repeat(64),
};

function fakeInvoke(answers: Record<string, unknown>) {
  const calls: Array<{ cmd: string; args: unknown; options?: { headers: Record<string, string> } }> = [];
  const invoke = (async (cmd: string, args?: unknown, options?: { headers: Record<string, string> }) => {
    calls.push({ cmd, args, options });
    return answers[cmd];
  }) as Invoke;
  return { invoke, calls };
}

describe("desktop Whisper model seam (W1.17)", () => {
  it("ships unpinned: no repo, revision, file, size or checksum is guessed", () => {
    expect(WHISPER_GGML).toMatchObject({ sourceRepo: "ivrit-ai/whisper-large-v3-turbo", license: "Apache-2.0", repo: null, revision: null, file: null, bytes: null, sha256: null });
    expect(isPinned(WHISPER_GGML)).toBe(false);
    expect(isPinned(PINNED)).toBe(true);
    expect(isPinned({ ...PINNED, revision: "main" })).toBe(false);
    expect(isPinned({ ...PINNED, file: "../x.bin" })).toBe(false);
    expect(isPinned({ ...PINNED, sha256: "D".repeat(64) })).toBe(false);
  });

  it("downloads only from the pinned revision", () => {
    if (!isPinned(PINNED)) throw new Error("fixture");
    expect(downloadUrl(PINNED)).toBe(`https://huggingface.co/example-owner/whisper-large-v3-turbo-ggml/resolve/${"c".repeat(40)}/ggml-model.bin`);
  });

  it("status: web build, unpinned, then what whisper_status reports", async () => {
    expect(await desktopWhisperStatus({ desktop: false })).toEqual({ kind: "web" });
    const never = fakeInvoke({});
    expect(await desktopWhisperStatus({ desktop: true, invoke: never.invoke })).toEqual({ kind: "unpinned" });
    expect(never.calls).toEqual([]);
    const ok = fakeInvoke({ whisper_status: { cli: "/opt/homebrew/bin/whisper-cli", model: "ok", model_path: "/d/whisper/ggml-model.bin" } });
    expect(await desktopWhisperStatus({ desktop: true, invoke: ok.invoke, model: PINNED })).toEqual({ kind: "ready" });
    expect(ok.calls[0]).toMatchObject({ cmd: "whisper_status", args: { file: "ggml-model.bin", bytes: 1_624_555_275, sha256: "d".repeat(64) } });
    const noCli = fakeInvoke({ whisper_status: { cli: null, model: "ok", model_path: "/p" } });
    expect(await desktopWhisperStatus({ desktop: true, invoke: noCli.invoke, model: PINNED })).toEqual({ kind: "no-cli", modelPath: "/p" });
    const bad = fakeInvoke({ whisper_status: { cli: "/w", model: "wrong-checksum", model_path: "/p" } });
    expect(await desktopWhisperStatus({ desktop: true, invoke: bad.invoke, model: PINNED })).toEqual({ kind: "model", state: "wrong-checksum", modelPath: "/p" });
  });

  it("sends 16-bit PCM with the language forced and the pinned file in headers; times come back in seconds", async () => {
    const pcm = toPcm16(new Float32Array([0, 1, -1, 0.5, 2]));
    expect(Array.from(new Int16Array(pcm.buffer))).toEqual([0, 32767, -32768, 16384, 32767]);
    const f = fakeInvoke({ whisper_transcribe: [{ start_ms: 0, end_ms: 2500, text: "שלום." }, { start_ms: 2500, end_ms: 4000, text: "מה נשמע?" }] });
    const segs = await transcribeDesktop(new Float32Array(16_000), { language: "he-IL", invoke: f.invoke, model: PINNED });
    expect(segs).toEqual([{ start: 0, end: 2.5, text: "שלום." }, { start: 2.5, end: 4, text: "מה נשמע?" }]);
    expect(f.calls[0].cmd).toBe("whisper_transcribe");
    expect((f.calls[0].args as Uint8Array).byteLength).toBe(32_000);
    expect(f.calls[0].options?.headers).toEqual({ "x-lumen-lang": "he", "x-lumen-model-file": "ggml-model.bin", "x-lumen-model-bytes": "1624555275", "x-lumen-model-sha256": "d".repeat(64) });
    await expect(transcribeDesktop(new Float32Array(1), { language: "he", invoke: f.invoke })).rejects.toThrow("not pinned");
  });
});

describe("engine choice for files (W1.17)", () => {
  const ctx = (over: Partial<EngineContext>): EngineContext => ({ language: "he-IL", policy: "local-only", mode: "file", webgpu: true, f16: true, vramMB: 4000, webSpeech: false, downloaded: new Set<EngineId>(), ...over });

  it("Hebrew files go to whisper.cpp on the desktop when it is ready, then the browser engines; Ozen v1 stays off until its licence is approved (W6.19)", () => {
    expect(OZEN_LICENSE_APPROVED).toBe(false);
    expect(chooseEngine(ctx({ desktopWhisper: true })).candidates).toEqual(["whisper-cpp-he", "whisper-turbo-he", "whisper-base"]);
    expect(chooseEngine(ctx({ desktopWhisper: false })).candidates).toEqual(["whisper-turbo-he", "whisper-base"]);
    expect(chooseEngine(ctx({ desktopWhisper: true, language: "en" })).candidates).toEqual(["whisper-base"]);
    expect(chooseEngine(ctx({ desktopWhisper: true })).needsDownload).toBeNull();
  });

  it("live dictation keeps the streaming Zipformer", () => {
    expect(chooseEngine(ctx({ mode: "live", desktopWhisper: true })).candidates[0]).toBe("zipformer-he");
  });
});

describe("long-file transcript (W1.17)", () => {
  it("clock", () => {
    expect([clock(7.9), clock(724), clock(3723)]).toEqual(["0:07", "12:04", "1:02:03"]);
  });

  it("splits a segment after each sentence, with proportional times", () => {
    const s = sentencesOf([{ start: 10, end: 20, text: "אחת שתיים. שלוש ארבע?" }]);
    expect(s.map((x) => x.text)).toEqual(["אחת שתיים.", "שלוש ארבע?"]);
    expect(s[0].start).toBe(10);
    expect(s[0].end).toBeCloseTo(10 + (10 * 10) / 21);
    expect(s[1].end).toBe(20);
  });

  it("joins a sentence that spans segments; a trailing fragment is its own line", () => {
    const s = sentencesOf([
      { start: 4, end: 6, text: "היום נדבר" },
      { start: 0, end: 4, text: "שלום לכולם." },
      { start: 6, end: 9, text: "על התקציב." },
      { start: 9, end: 10, text: "ו" },
    ]);
    expect(s).toEqual([
      { start: 0, end: 4, text: "שלום לכולם." },
      { start: 4, end: 9, text: "היום נדבר על התקציב." },
      { start: 9, end: 10, text: "ו" },
    ]);
  });

  it("caps a run-on sentence so its link lands near the words", () => {
    const segs = Array.from({ length: 6 }, (_, i) => ({ start: i * 10, end: i * 10 + 10, text: `מילה ${i}` }));
    const s = sentencesOf(segs, 30);
    expect(s.map((x) => [x.start, x.end])).toEqual([[0, 30], [30, 60]]);
  });

  it("Markdown: one line per sentence, its time a link into the audio", () => {
    const s = [{ start: 724.2, end: 730.1, text: "שלום." }, { start: 3723, end: 3724, text: "Bye." }];
    expect(timeFragment(s[0])).toBe("#t=724,731");
    expect(transcriptMarkdown(s, "attachments/2026-11-10-talk.m4a")).toBe("[▶ 12:04](<attachments/2026-11-10-talk.m4a#t=724,731>) שלום.\n[▶ 1:02:03](<attachments/2026-11-10-talk.m4a#t=3723,3724>) Bye.");
    expect(transcriptMarkdown(s)).toBe("`12:04` שלום.\n`1:02:03` Bye.");
  });

  it("browser chunks are moved onto the file's clock; an open end closes at the next start", () => {
    const out = { text: "x", chunks: [{ text: " א.", timestamp: [0, 2] as [number, number] }, { text: " ב", timestamp: [2, null] as [number, null] }, { text: " ", timestamp: [5, 6] as [number, number] }] };
    expect(timedChunks(out, 30, 28)).toEqual([{ start: 30, end: 32, text: "א." }, { start: 32, end: 35, text: "ב" }]);
    expect(timedChunks({ text: "y" }, 0, 10)).toEqual([]);
  });

  it("the audio goes under attachments/ with a safe name", () => {
    const when = new Date("2026-11-10T12:00:00Z");
    expect(attachmentName("ישיבת צוות 3.11.M4A", when)).toBe("attachments/2026-11-10-ישיבת-צוות-3-11.m4a");
    expect(attachmentName("../../etc/passwd", when)).toBe("attachments/2026-11-10-passwd");
    expect(attachmentName("", when)).toBe("attachments/2026-11-10-audio");
  });
});

describe("file transcription strings ship with their chunk (W1.17)", () => {
  const SRC = resolve(__dirname, "..");
  const files: Array<{ path: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "__tests__") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) files.push({ path: relative(SRC, p).replace(/\\/g, "/"), text: readFileSync(p, "utf8") });
    }
  };
  walk(SRC);
  const lazy = JSON.parse(readFileSync(join(SRC, "i18n", "lazy", "transcribeFile.json"), "utf8")) as Record<string, string>;
  // The startup English: every domain file of locales/en/ (plan 0.3).
  const startup = readLocale("en");

  it("no lazy key is in the startup bundle; only the palette label is", () => {
    for (const k of Object.keys(lazy)) expect(k in startup, k).toBe(false);
    expect("cmd.tools.transcribeFile" in startup).toBe(true);
  });

  it("only the strings module imports the JSON, only TranscribeFile imports that, and nothing imports TranscribeFile statically", () => {
    expect(files.filter((f) => f.text.includes("i18n/lazy/transcribeFile.json")).map((f) => f.path)).toEqual(["ai/dictation/strings.ts"]);
    // Imports that resolve to ai/dictation/strings (other folders have a strings module of their own).
    const importsStrings = (f: { path: string; text: string }) =>
      [...f.text.matchAll(/^import "([./][^"]*)";/gm)].some((m) => relative(SRC, resolve(SRC, f.path, "..", m[1])).replace(/\\/g, "/") === "ai/dictation/strings");
    expect(files.filter((f) => importsStrings(f) && f.path !== "ai/dictation/strings.ts").map((f) => f.path)).toEqual(["ui/TranscribeFile.ts"]);
    for (const f of files) expect(/^import [^;]*from "[./]*(ui\/)?TranscribeFile";/m.test(f.text), f.path).toBe(false);
    expect(files.some((f) => /^commands\//.test(f.path) && /import\("(\.\.\/)+ui\/TranscribeFile"\)/.test(f.text))).toBe(true);
  });

  it("t() resolves the lazy keys once the module is loaded", () => {
    expect(t("transcribeFile.done", { n: 3, seconds: 1.5 })).toBe("Transcribed 3 sentences in 1.5 s.");
  });
});
