/**
 * English of lazily loaded domains (src/i18n/lazy/<domain>.json): kept out
 * of the startup bundle, registered when the domain's chunk loads. Here: the
 * quick / voice capture strings and the fine-tune panel's (plan W1.13 — the
 * voice button pushed the startup total over its 460 KB budget).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { lazyEnglish } from "./helpers/i18nLazy";
import { registerEnglish, t } from "../i18n";

const SRC = resolve(__dirname, "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "__tests__" || e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

const rel = (f: string) => relative(SRC, f).replace(/\\/g, "/");

/** Modules (paths under src/, without extension) that `text` in `from` imports statically. */
function staticImports(from: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^import (?!type )(?:[^;]*? from )?"(\.[^"]+)";/gm)) {
    out.push(rel(resolve(SRC, from, "..", m[1])).replace(/\.tsx?$/, ""));
  }
  return out;
}
const noExt = (p: string) => p.replace(/\.tsx?$/, "");

/** Each lazy file → its prefix, its strings module, the modules that import that, and what must stay lazy. */
const DOMAINS = [
  {
    file: "capture.json",
    prefix: "capture.",
    module: "capture/strings.ts",
    users: ["capture/quickCapture.ts", "ui/QuickCapture.tsx"],
    // Loaded with the capture box (QuickCapture.tsx imports it dynamically).
    sameChunk: ["capture/voiceCapture.ts"],
    min: 15,
  },
  {
    file: "fineTune.json",
    prefix: "fineTune.",
    module: "ui/fineTuneStrings.ts",
    users: ["ui/FineTuneSettings.tsx"],
    sameChunk: [] as string[],
    min: 20,
  },
];

describe("i18n: lazy English (capture, fine-tune)", () => {
  const lazy = lazyEnglish();
  // The startup English: every domain file of locales/en/ (plan 0.3 layout).
  const enDir = join(SRC, "i18n", "locales", "en");
  const index = readdirSync(enDir).filter((n) => n.endsWith(".json")).map((n) => readFileSync(join(enDir, n), "utf8")).join("\n");
  const files = sources(SRC).map((f) => ({ path: rel(f), text: readFileSync(f, "utf8") }));

  it("no lazy key is duplicated in the startup bundle", () => {
    for (const k of Object.keys(lazy)) expect(index.includes(`"${k}":`), k).toBe(false);
    // The palette and the shortcuts list show these at startup.
    for (const k of ["capture.title", "cmd.fineTune.open"]) {
      expect(index.includes(`"${k}":`), k).toBe(true);
      expect(lazy[k], k).toBeUndefined();
    }
  });

  for (const d of DOMAINS) {
    it(`${d.file}: its keys, imported only by ${d.module}, used only by modules that load on demand`, () => {
      const own = JSON.parse(readFileSync(join(SRC, "i18n", "lazy", d.file), "utf8")) as Record<string, string>;
      expect(Object.keys(own).length).toBeGreaterThanOrEqual(d.min);
      expect(Object.keys(own).every((k) => k.startsWith(d.prefix))).toBe(true);
      const importers = files.filter((f) => f.text.includes(`i18n/lazy/${d.file}`)).map((f) => f.path);
      expect(importers).toEqual([d.module]);
      const users = files.filter((f) => staticImports(f.path, f.text).includes(noExt(d.module))).map((f) => f.path).sort();
      expect(users).toEqual(d.users);
      // …and no module outside the domain's own lazy chunk imports a user statically.
      for (const f of files) {
        if (d.users.includes(f.path) || d.sameChunk.includes(f.path)) continue;
        const imports = staticImports(f.path, f.text);
        for (const u of d.users) expect(imports.includes(noExt(u)), `${f.path} imports ${u} statically`).toBe(false);
      }
    });
  }

  it("registerEnglish makes t() resolve the keys, without replacing existing English", async () => {
    await import("../capture/strings");
    await import("../ui/fineTuneStrings");
    expect(t("capture.voice.start")).toBe(lazy["capture.voice.start"]);
    expect(t("capture.saved", { path: "inbox.md" })).toBe("Added to inbox.md");
    expect(t("fineTune.training", { status: "queued" })).toBe("Training… (queued)");
    registerEnglish({ "capture.title": "replaced?", "test.lazy.capture": "lazy" });
    expect(t("capture.title")).toBe("Quick capture");
    expect(t("test.lazy.capture")).toBe("lazy");
  });
});
