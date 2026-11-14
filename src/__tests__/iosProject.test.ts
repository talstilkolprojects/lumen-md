/**
 * Audit W10.C7 (plans W3.4, W4.22): every Swift file of the iOS app is in
 * an Xcode target. Before, LumenIntents, LumenNative, iCloudSync and the
 * widget were not in project.pbxproj, so Siri's intents and the widget
 * never compiled. The project file is parsed (its OpenStep plist syntax),
 * not grepped. Compiling is the Mac's (10.M).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

type V = string | V[] | { [k: string]: V };

/** A parser for the OpenStep property lists Xcode writes: dicts, arrays, strings; comments skipped. */
function parseOpenStep(text: string): V {
  let i = 0;
  const ws = () => {
    for (;;) {
      if (/\s/.test(text[i] ?? "")) i++;
      else if (text.startsWith("/*", i)) i = text.indexOf("*/", i) + 2;
      else if (text.startsWith("//", i)) i = text.indexOf("\n", i) + 1;
      else return;
    }
  };
  const str = (): string => {
    ws();
    if (text[i] === '"') {
      let out = "";
      i++;
      while (text[i] !== '"') {
        if (text[i] === "\\") i++;
        out += text[i++];
      }
      i++;
      return out;
    }
    const m = /^[A-Za-z0-9_$./:+\-<>]+/.exec(text.slice(i));
    if (!m) throw new Error(`unexpected ${JSON.stringify(text.slice(i, i + 20))} at ${i}`);
    i += m[0].length;
    return m[0];
  };
  const value = (): V => {
    ws();
    if (text[i] === "{") {
      i++;
      const d: Record<string, V> = {};
      for (;;) {
        ws();
        if (text[i] === "}") return i++, d;
        const k = str();
        ws();
        if (text[i++] !== "=") throw new Error(`= expected at ${i}`);
        if (k in d) throw new Error(`duplicate key ${k}`);
        d[k] = value();
        ws();
        if (text[i++] !== ";") throw new Error(`; expected at ${i}`);
      }
    }
    if (text[i] === "(") {
      i++;
      const a: V[] = [];
      for (;;) {
        ws();
        if (text[i] === ")") return i++, a;
        a.push(value());
        ws();
        if (text[i] === ",") i++;
      }
    }
    return str();
  };
  const v = value();
  ws();
  if (i < text.length) throw new Error(`trailing text at ${i}`);
  return v;
}

const ROOT = process.cwd();
const project = parseOpenStep(readFileSync(join(ROOT, "ios/App/App.xcodeproj/project.pbxproj"), "utf8")) as Record<string, V>;
const objects = project.objects as Record<string, Record<string, V>>;
const obj = (id: string) => {
  const o = objects[id];
  if (!o) throw new Error(`dangling reference ${id}`);
  return o;
};
const targets = () => Object.entries(objects).filter(([, o]) => o.isa === "PBXNativeTarget");
const target = (name: string) => targets().find(([, o]) => o.name === name)!;
const phase = (t: Record<string, V>, isa: string) => (t.buildPhases as string[]).map(obj).find((p) => p.isa === isa)!;
/** A file reference's path from the project root (its groups' paths joined). */
function pathOf(refId: string): string {
  const parents = new Map<string, string>();
  for (const [id, o] of Object.entries(objects)) for (const c of (o.children as string[] | undefined) ?? []) parents.set(c, id);
  const parts: string[] = [];
  for (let id: string | undefined = refId; id; id = parents.get(id)) {
    const o = obj(id);
    if (typeof o.path === "string") parts.unshift(o.path);
  }
  return parts.join("/");
}
const sourcesOf = (name: string) => ((phase(target(name)[1], "PBXSourcesBuildPhase").files as string[]) ?? []).map((bf) => "ios/App/" + pathOf(obj(bf).fileRef as string));

function swiftFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      // CapApp-SPM is a Swift package Xcode builds through its Package.swift, not a target of this project.
      if (e !== "CapApp-SPM" && !e.endsWith(".xcodeproj")) swiftFiles(p, out);
    } else if (e.endsWith(".swift")) out.push(relative(ROOT, p).split("\\").join("/"));
  }
  return out;
}

describe("the iOS project (W10.C7)", () => {
  it("parses, and every reference points at an object", () => {
    for (const [id, o] of Object.entries(objects)) {
      expect(id, id).toMatch(/^[0-9A-F]{24}$/);
      for (const k of ["fileRef", "target", "targetProxy", "productReference", "buildConfigurationList"]) if (typeof o[k] === "string") obj(o[k] as string);
      for (const k of ["files", "children", "buildPhases", "dependencies", "buildConfigurations", "targets"]) for (const r of (o[k] as string[] | undefined) ?? []) obj(r);
    }
  });

  it("0 Swift files outside a target: the app's in App, the widget's in LumenWidgets", () => {
    const inTargets = new Set([...sourcesOf("App"), ...sourcesOf("LumenWidgets")]);
    const all = swiftFiles(join(ROOT, "ios/App"));
    expect(all.filter((f) => !inTargets.has(f))).toEqual([]);
    expect(sourcesOf("App").sort()).toEqual(["ios/App/App/AppDelegate.swift", "ios/App/App/LumenIntents.swift", "ios/App/App/LumenNative.swift", "ios/App/App/iCloudSync.swift"]);
    expect(sourcesOf("LumenWidgets")).toEqual(["ios/App/LumenWidgets/LumenWidgets.swift"]);
  });

  it("the widget is an app extension the app builds first and embeds", () => {
    const [wid, w] = target("LumenWidgets");
    expect(w.productType).toBe("com.apple.product-type.app-extension");
    expect(obj(w.productReference as string).path).toBe("LumenWidgets.appex");
    const [, app] = target("App");
    const dep = (app.dependencies as string[]).map(obj).find((d) => d.target === wid);
    expect(dep).toBeTruthy();
    const embed = (app.buildPhases as string[]).map(obj).find((p) => p.isa === "PBXCopyFilesBuildPhase")!;
    expect(embed.dstSubfolderSpec).toBe("13"); // PlugIns
    expect((embed.files as string[]).map((f) => obj(obj(f).fileRef as string).path)).toEqual(["LumenWidgets.appex"]);
    expect((obj(project.rootObject as string).targets as string[]).map((t) => obj(t).name)).toEqual(["App", "LumenWidgets"]);
  });

  it("each target has its Info.plist, entitlements with the App Group, bundle id and version in lock-step", () => {
    const settings = (name: string) => (obj(target(name)[1].buildConfigurationList as string).buildConfigurations as string[]).map((c) => obj(c).buildSettings as Record<string, string>);
    for (const s of settings("LumenWidgets")) {
      expect(s.PRODUCT_BUNDLE_IDENTIFIER).toBe("com.lumen.editor.LumenWidgets");
      expect(s.INFOPLIST_FILE).toBe("LumenWidgets/Info.plist");
      expect(s.CODE_SIGN_ENTITLEMENTS).toBe("LumenWidgets/LumenWidgets.entitlements");
    }
    for (const s of settings("App")) expect(s.CODE_SIGN_ENTITLEMENTS).toBe("App/App.entitlements");
    // The extension's version must match the app's (App Store rule): the release bump changes all of them.
    const versions = new Set([...settings("App"), ...settings("LumenWidgets")].map((s) => `${s.MARKETING_VERSION}/${s.CURRENT_PROJECT_VERSION}`));
    expect(versions.size).toBe(1);
    const info = readFileSync(join(ROOT, "ios/App/LumenWidgets/Info.plist"), "utf8");
    expect(info).toMatch(/<key>NSExtensionPointIdentifier<\/key>\s*<string>com\.apple\.widgetkit-extension<\/string>/);
    expect(info).toMatch(/<key>CFBundleShortVersionString<\/key>\s*<string>\$\(MARKETING_VERSION\)<\/string>/);
    for (const f of ["ios/App/App/App.entitlements", "ios/App/LumenWidgets/LumenWidgets.entitlements"]) {
      expect(readFileSync(join(ROOT, f), "utf8")).toMatch(/<key>com\.apple\.security\.application-groups<\/key>\s*<array>\s*<string>group\.com\.lumen\.editor<\/string>/);
    }
    // The group the app reads (AppDelegate's shared defaults) is the one granted.
    expect(readFileSync(join(ROOT, "ios/App/App/AppDelegate.swift"), "utf8")).toContain('suiteName: "group.com.lumen.editor"');
  });

  it("the Hebrew and English strings are in both targets' resources, and Hebrew is a known region", () => {
    const res = (name: string) => ((phase(target(name)[1], "PBXResourcesBuildPhase").files as string[]) ?? []).map((bf) => obj(obj(bf).fileRef as string)).filter((o) => o.isa === "PBXVariantGroup");
    const langs = (g: Record<string, V>) => (g.children as string[]).map((c) => obj(c).name).sort();
    expect(res("App").map((g) => [g.name, langs(g)]).filter(([n]) => n !== "Main.storyboard" && n !== "LaunchScreen.storyboard")).toEqual([
      ["Localizable.strings", ["en", "he"]],
      ["AppShortcuts.strings", ["en", "he"]],
    ]);
    expect(res("LumenWidgets").map((g) => [g.name, langs(g)])).toEqual([["Localizable.strings", ["en", "he"]]]);
    expect(obj(project.rootObject as string).knownRegions).toContain("he");
  });
});
