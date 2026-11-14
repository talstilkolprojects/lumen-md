// @vitest-environment node
/**
 * Plan W2.6 — everything but the voice: `npm run tts:voice` checks a
 * candidate Hebrew voice before it is listed (coverage of the G2P's
 * phonemes, licences per decision 15.10, pinned files) and prints the
 * entries to add. Run here on synthetic files: no voice may ship yet.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { G2P_PHONEMES } from "../ai/tts/hebrewG2P";
// @ts-expect-error — plain .mjs script without type declarations
import { configProblems, isPinnedUrl, licenceProblems, PAUSES } from "../../scripts/lib/tts-voice.mjs";

const registry = { models: [
  { id: "mms-tts-heb", class: "forbidden", license: "CC-BY-NC-4.0", source: "https://huggingface.co/facebook/mms-tts-heb" },
  { id: "saspeech-voices", class: "forbidden", license: "SASPEECH (non-commercial)", source: "https://www.openslr.org/134/", match: ["saspeech"] },
  { id: "phonikud-tts", class: "forbidden", license: "non-commercial", source: "https://huggingface.co/thewh1teagle" },
] };
const SHA = "0123456789abcdef0123456789abcdef01234567";
const config = (drop: string[] = []) => ({ audio: { sample_rate: 22050 }, phoneme_id_map: Object.fromEntries(["^", "$", "_", ...PAUSES, ...G2P_PHONEMES].filter((p) => !drop.includes(p)).map((p, i) => [p, [i]])) });
const good = { id: "he-test-voice", license: "Apache-2.0", dataLicense: "CC0-1.0", attribution: "Test voice by someone", modelUrl: `https://huggingface.co/example/he-voice/resolve/${SHA}/he.onnx`, configUrl: `https://huggingface.co/example/he-voice/resolve/${SHA}/he.onnx.json` };

describe("W2.6 a candidate voice, checked before it is listed", () => {
  it("must cover every phoneme the G2P writes and the pauses", () => {
    expect(configProblems(config(), G2P_PHONEMES)).toEqual([]);
    expect(configProblems(config(["χ", "ʁ"]), G2P_PHONEMES).join(" ")).toContain("2 of the G2P's phonemes: ʁ χ");
    expect(configProblems(config(["?"]), G2P_PHONEMES).join(" ")).toContain("pause marks");
    expect(configProblems(config(["_"]), G2P_PHONEMES).join(" ")).toContain('lacks "_"');
    expect(configProblems({ phoneme_id_map: {} }, G2P_PHONEMES)[0]).toContain("sample_rate");
  });

  it("needs licences that allow shipping it, for the weights and the data, and nothing on the deny-list", () => {
    expect(licenceProblems(good, registry)).toEqual([]);
    expect(licenceProblems({ ...good, dataLicense: undefined }, registry)[0]).toContain("training data's licence");
    for (const bad of ["CC-BY-NC-4.0", "CC BY-NC-SA 4.0", "non-commercial", "GPL-3.0", "CC-BY-ND-4.0", "research only"]) expect(licenceProblems({ ...good, dataLicense: bad }, registry).join(" "), bad).toContain("does not allow");
    // A voice trained on SASPEECH, or any file under a forbidden author's page.
    expect(licenceProblems({ ...good, attribution: "Fine-tuned on SASPEECH" }, registry).join(" ")).toContain("saspeech-voices");
    expect(licenceProblems({ ...good, modelUrl: `https://huggingface.co/thewh1teagle/x/resolve/${SHA}/a.onnx` }, registry).join(" ")).toContain("phonikud-tts");
  });

  it("files are pinned to a revision over https", () => {
    expect(isPinnedUrl(good.modelUrl)).toBe(true);
    expect(isPinnedUrl("https://github.com/o/r/releases/download/v1.0/he.onnx")).toBe(true);
    expect(isPinnedUrl("https://huggingface.co/example/he-voice/resolve/main/he.onnx")).toBe(false);
    expect(isPinnedUrl(`http://huggingface.co/example/he-voice/resolve/${SHA}/he.onnx`)).toBe(false);
  });

  it("the command prints the entries with the files' sizes and sha256, and refuses with the reasons", () => {
    const dir = mkdtempSync(join(tmpdir(), "w26-"));
    const model = join(dir, "he.onnx");
    const cfg = join(dir, "he.onnx.json");
    const bytes = new Uint8Array(4096).map((_, i) => i % 251);
    writeFileSync(model, bytes);
    writeFileSync(cfg, JSON.stringify(config()));
    const run = (args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/tts-voice.mjs", ...args], { encoding: "utf8" });
    expect(run(["check", cfg]).status).toBe(0);
    const pin = ["pin", "--id", good.id, "--model", model, "--config", cfg, "--model-url", good.modelUrl, "--config-url", good.configUrl, "--license", good.license, "--data-license", good.dataLicense, "--attribution", good.attribution];
    const ok = run(pin);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain(`sha256: "${createHash("sha256").update(bytes).digest("hex")}"`);
    expect(ok.stdout).toContain("bytes: 4096");
    expect(ok.stdout).toContain('"verified": false');
    // The real registry's deny-list applies too.
    const nc = run([...pin.slice(0, -4), "--data-license", "CC-BY-NC-4.0", "--attribution", good.attribution]);
    expect(nc.status).toBe(1);
    expect(nc.stderr).toContain("does not allow");
    writeFileSync(cfg, JSON.stringify(config(["ʃ"])));
    const short = run(["check", cfg]);
    expect(short.status).toBe(1);
    expect(short.stderr).toContain("ʃ");
  });
});
