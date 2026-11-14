/**
 * Audit W10.C14 (plan 4.20): the Android vault-folder plugin is part of the
 * app and registered, so the phone's vault no longer works only against
 * fakes. The Java itself is compiled offline by
 * tools/native-check/check-android.sh (javac -Xlint:all -Werror).
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const JAVA = "android/app/src/main/java/com/lumen/editor";

describe("the Android vault-folder plugin (W10.C14)", () => {
  it("lives in the app's sources, once, under the name the JavaScript side asks for", () => {
    const plugin = read(`${JAVA}/LumenVaultFolderPlugin.java`);
    expect(plugin).toMatch(/^package com\.lumen\.editor;/m);
    const name = /@CapacitorPlugin\(name = "([^"]+)"\)/.exec(plugin)![1];
    expect(read("src/storage/vault/mobile.ts")).toContain(`registerPlugin<LumenVaultFolderPlugin>("${name}")`);
    expect(existsSync(join(ROOT, "mobile/android/LumenVaultFolderPlugin.java"))).toBe(false);
  });

  it("MainActivity registers it before the bridge starts", () => {
    const main = read(`${JAVA}/MainActivity.java`);
    const reg = main.indexOf("registerPlugin(LumenVaultFolderPlugin.class);");
    expect(reg).toBeGreaterThan(-1);
    expect(reg).toBeLessThan(main.indexOf("super.onCreate(savedInstanceState);"));
  });

  it("needs no broad storage permission: the Storage Access Framework grants the picked folder, the fallback is the app's own folder", () => {
    const manifest = read("android/app/src/main/AndroidManifest.xml");
    expect(manifest).not.toMatch(/READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE|READ_MEDIA_/);
    const plugin = read(`${JAVA}/LumenVaultFolderPlugin.java`);
    expect(plugin).toContain("Intent.ACTION_OPEN_DOCUMENT_TREE");
    expect(plugin).toMatch(/takePersistableUriPermission\(tree,\s*Intent\.FLAG_GRANT_READ_URI_PERMISSION \| Intent\.FLAG_GRANT_WRITE_URI_PERMISSION\)/);
  });
});
