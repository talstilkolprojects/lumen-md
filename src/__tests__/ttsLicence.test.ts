/**
 * Plan 6.2 (spike, docs/adr/003-neural-tts-licence.md): until decision
 * 15.10(1), read-aloud stays on the system's voices. No package that bundles
 * eSpeak NG (GPL-3.0) may be a dependency, the licence gate keeps failing
 * them, and speak() makes no network request.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const ESPEAK = ["phonemizer", "kokoro-js", "@mintplex-labs/piper-tts-web", "@diffusionstudio/vits-web"];

describe("read-aloud licence guard (6.2, until 15.10(1))", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("has no dependency that bundles eSpeak NG", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
    for (const name of ESPEAK) expect(Object.keys(deps), name).not.toContain(name);
  });

  it("the licence gate fails each of them", async () => {
    // @ts-expect-error — plain .mjs module
    const { HIDDEN_COPYLEFT } = (await import("../../scripts/lib/licenses.mjs")) as { HIDDEN_COPYLEFT: Array<{ name: string; level: string; reason: string }> };
    for (const name of ["phonemizer", "@mintplex-labs/piper-tts-web", "@diffusionstudio/vits-web"]) {
      const rule = HIDDEN_COPYLEFT.find((r) => r.name === name);
      expect(rule?.level, name).toBe("fail");
      expect(rule?.reason, name).toMatch(/eSpeak NG/);
    }
  });

  it("speak() uses the system voices and makes no request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const spoken: string[] = [];
    class U {
      lang = "";
      rate = 1;
      voice: unknown = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public text: string) {}
    }
    vi.stubGlobal("SpeechSynthesisUtterance", U);
    // The device's own voices: since #195 a sentence with no local voice is not handed to the browser.
    const voices = [
      { name: "Local English", lang: "en-US", localService: true },
      { name: "Local Hebrew", lang: "he-IL", localService: true },
    ];
    const synth = { getVoices: () => voices, cancel: () => undefined, speak: (u: U) => (spoken.push(u.text), queueMicrotask(() => u.onend?.())) };
    vi.stubGlobal("speechSynthesis", synth);
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: synth });
    const { speak } = await import("../ai/tts");
    await speak("Hello there. שלום לכם.", { uiLang: "en" });
    expect(spoken.length).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
