/**
 * English of lazily loaded domains (src/i18n/lazy/<domain>.json): kept out
 * of the startup bundle, registered when the domain's chunk loads.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { lazyEnglish, LAZY_DIR } from "./helpers/i18nLazy";
import { readLocale } from "../../scripts/lib/i18n-files.mjs";
import { registerEnglish, t } from "../i18n";

const SRC = resolve(__dirname, "..");

/**
 * Each lazy file, the one strings module that imports it, and the modules
 * allowed to import that strings module — all of them reached only through
 * a dynamic import, so the strings never join the startup bundle. `within`:
 * a folder that is itself loaded only lazily (nothing outside it imports it
 * statically); the users may import each other statically inside it.
 */
const DOMAINS: Record<string, { module: string; users: string[]; prefixes: string[]; within?: string; shared?: string[] }> = {
  "caption.json": { module: "ai/captionStrings.ts", users: ["ai/caption.ts"], prefixes: ["caption."] },
  "nikud.json": { module: "ai/nikudStrings.ts", users: ["ai/nikudService.ts"], prefixes: ["toast.nikud.", "models.purpose.nikud"] },
  "eviction.json": { module: "storage/evictionStrings.ts", users: ["storage/evictionReminder.ts"], prefixes: ["storage.eviction."] },
  "analyst.json": { module: "agents/analystStrings.ts", users: ["agents/analyst.ts"], prefixes: ["analyst.", "cmd.ai.analyse.ask"] },
  "lora.json": { module: "ai/localLoraStrings.ts", users: ["ui/FineTuneSettings.tsx", "ui/LocalLoraSection.tsx"], prefixes: ["lora.", "fineTune.cloudRoute"] },
  "doctor.json": { module: "agents/doctorStrings.ts", users: ["ui/AiDoctorPanel.tsx"], prefixes: ["ai.doctor."] },
  "imageSearch.json": { module: "ai/imageSearchStrings.ts", users: ["ui/SearchDialog.tsx", "ui/ImageSearchPanel.tsx", "ai/imageSearchService.ts"], prefixes: ["imageSearch."] },
  "mt.json": { module: "ai/mt/strings.ts", users: ["ai/mt/index.ts", "agents/commands.ts"], prefixes: ["models.", "mt.", "toast.translatedWith", "toast.localMtUnavailable"] },
  // Encrypted sync (plan 3.4): the whole of src/sync/e2ee/ loads on demand.
  // `shared`: the string-free crypto helpers the encrypted vault (plan 11.4) uses too; they may be
  // imported from outside, and must not reach the strings.
  "e2ee.json": {
    module: "sync/e2ee/strings.ts",
    users: ["sync/e2ee/conflict.ts", "sync/e2ee/ui/FreshnessBanner.tsx", "sync/e2ee/ui/PassphraseForm.tsx", "sync/e2ee/ui/SyncPanel.tsx"],
    prefixes: ["e2ee."],
    within: "sync/e2ee/",
    shared: ["sync/e2ee/bytes.ts", "sync/e2ee/kdf.ts"],
  },
  "feedback.json": { module: "feedback/strings.ts", users: ["ui/FeedbackDialog.tsx"], prefixes: ["feedback."] },
  // The encrypted vault's dialogs (plan 11.4), opened with a dynamic import.
  "vaultEncryption.json": { module: "storage/vault/encrypted/strings.ts", users: ["ui/VaultEncryptionDialog.tsx", "ui/VaultUnlock.tsx"], prefixes: ["vaultEnc."] },
  // The webR download offer (plan W1.34), in the lazily rendered live-R block.
  "webr.json": { module: "plugins/r/webrStrings.ts", users: ["plugins/LiveRBlock.tsx"], prefixes: ["block.liveR.install."] },
  // Chat import (plan W5.7): the command loads its module with a dynamic import.
  "chatImport.json": { module: "capture/chats/strings.ts", users: ["capture/chats/runImport.ts"], prefixes: ["chatImport."] },
};

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

describe("i18n: lazy English", () => {
  const lazy = lazyEnglish();
  // The startup English: every domain file of locales/en/ (plan 0.3).
  const startup = readLocale("en");
  const files = sources(SRC);

  it("every lazy file is declared, and none of its keys is also in the startup bundle", () => {
    expect(readdirSync(LAZY_DIR).sort()).toEqual(Object.keys(DOMAINS).sort());
    for (const f of readdirSync(LAZY_DIR)) expect(Object.keys(JSON.parse(readFileSync(join(LAZY_DIR, f), "utf8")) as object).length, f).toBeGreaterThan(0);
    for (const k of Object.keys(lazy)) expect(k in startup, k).toBe(false);
  });

  it("keys stay inside their domain's prefixes", () => {
    for (const [file, d] of Object.entries(DOMAINS)) {
      const keys = Object.keys(JSON.parse(readFileSync(join(LAZY_DIR, file), "utf8")) as Record<string, string>);
      for (const k of keys) expect(d.prefixes.some((p) => k.startsWith(p)), `${file}: ${k}`).toBe(true);
    }
  });

  it("each file is imported only by its strings module, and that module only by its declared users", () => {
    for (const [file, d] of Object.entries(DOMAINS)) {
      const importers = files.filter((f) => readFileSync(f, "utf8").includes(`i18n/lazy/${file}`)).map(rel);
      expect(importers).toEqual([d.module]);
      const stem = d.module.replace(/\.ts$/, "");
      const users = files
        .filter((f) => f !== join(SRC, d.module))
        .filter((f) => {
          const src = readFileSync(f, "utf8");
          return [...src.matchAll(/import\s+(?:[^"']*from\s+)?["']([^"']+)["']/g)].some((m) => {
            if (!m[1].startsWith(".")) return false;
            return rel(resolve(join(f, ".."), m[1])) === stem;
          });
        })
        .map(rel)
        .sort();
      expect(users).toEqual([...d.users].sort());
    }
  });

  it("the declared users are themselves only loaded with a dynamic import", () => {
    for (const d of Object.values(DOMAINS)) {
      if (d.within) {
        const shared = new Set((d.shared ?? []).map((x) => x.replace(/\.tsx?$/, "")));
        // A shared helper imports nothing but the other shared helpers, so it never reaches the strings.
        for (const x of d.shared ?? []) {
          const f = join(SRC, x);
          for (const m of readFileSync(f, "utf8").matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*from\s+)?["']([^"']+)["']/gm)) {
            expect(shared.has(rel(resolve(join(f, ".."), m[1]))), `${x} imports ${m[1]}`).toBe(true);
          }
        }
        // Nothing outside the lazily loaded folder imports it statically (the shared helpers aside).
        for (const f of files) {
          if (rel(f).startsWith(d.within)) continue;
          const src = readFileSync(f, "utf8");
          for (const m of src.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*from\s+)?["']([^"']+)["']/gm)) {
            if (!m[1].startsWith(".")) continue;
            const target = rel(resolve(join(f, ".."), m[1]));
            if (shared.has(target)) continue;
            expect(target.startsWith(d.within), `${rel(f)} imports ${m[1]} statically`).toBe(false);
          }
        }
        continue;
      }
      for (const u of d.users) {
        const stem = u.replace(/\.tsx?$/, "");
        for (const f of files) {
          if (rel(f) === u) continue;
          const src = readFileSync(f, "utf8");
          for (const m of src.matchAll(/^\s*import\s+(?!type\b)(?:[^"';]*from\s+)?["']([^"']+)["']/gm)) {
            if (!m[1].startsWith(".")) continue;
            expect(rel(resolve(join(f, ".."), m[1])) === stem, `${rel(f)} imports ${u} statically`).toBe(false);
          }
        }
      }
    }
  });

  it("registerEnglish makes t() resolve the keys, without replacing existing English", async () => {
    await import("../sync/e2ee/strings");
    expect(t("e2ee.setup.title")).toBe(lazy["e2ee.setup.title"]);
    expect(t("e2ee.setup.tooShort", { n: 12 })).toBe("At least 12 characters.");
    await import("../ai/mt/strings");
    expect(t("mt.layer.name.opus")).toBe(lazy["mt.layer.name.opus"]);
    expect(t("toast.translatedWith", { layer: "X" })).toBe("Translated with X");
    registerEnglish({ "dialog.ok": "replaced?", "test.lazy.only": "lazy" });
    expect(t("dialog.ok")).toBe("OK");
    expect(t("test.lazy.only")).toBe("lazy");
  });
});
