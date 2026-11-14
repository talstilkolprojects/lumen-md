/**
 * W3.4 — widgets, Shortcuts and Siri. The seam (src/mobile/nativeActions.ts):
 * action links, the queue of captures from Siri, tap latency; and the
 * native files say what the docs say (links, RTL, Hebrew, registration).
 * Real-device checks are manual (docs: editor/widgets).
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyAction, drainPending, initNativeBridge, noteTap, parseNativeUrl, tapLatency, tapReady, validPending, type LumenNativePlugin, type NativeHandlers } from "../mobile/nativeActions";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("action links", () => {
  it("each action, with Hebrew text and the tap time", () => {
    expect(parseNativeUrl("lumen://capture")).toEqual({ action: { kind: "capture", mode: "text", text: null }, tappedAt: null });
    expect(parseNativeUrl("lumen://capture?mode=voice&t=1762761900000")).toEqual({ action: { kind: "capture", mode: "voice", text: null }, tappedAt: 1762761900000 });
    expect(parseNativeUrl("lumen://capture?text=%D7%9C%D7%A7%D7%A0%D7%95%D7%AA%20%D7%97%D7%9C%D7%91")!.action).toEqual({ kind: "capture", mode: "text", text: "לקנות חלב" });
    expect(parseNativeUrl("lumen://new")!.action).toEqual({ kind: "new" });
    expect(parseNativeUrl("lumen://search?q=%20%D7%9E%D7%97%D7%A7%D7%A8%20%20%D7%A8%D7%90%D7%A9%D7%95%D7%9F")!.action).toEqual({ kind: "search", query: "מחקר ראשון" });
    expect(parseNativeUrl("lumen://search")!.action).toEqual({ kind: "search", query: "" });
    expect(parseNativeUrl("lumen://daily/")!.action).toEqual({ kind: "daily" });
    expect(parseNativeUrl("lumen:daily")!.action).toEqual({ kind: "daily" });
  });

  it("anything else is ignored", () => {
    for (const bad of ["https://evil.example/capture", "lumen://delete?path=a.md", "lumen://", "not a url", `lumen://capture?text=${"a".repeat(9000)}`]) expect(parseNativeUrl(bad), bad).toBe(null);
    // A bogus tap time is dropped, the action kept; control characters are stripped.
    expect(parseNativeUrl("lumen://capture?t=12")!.tappedAt).toBe(null);
    expect(parseNativeUrl("lumen://capture?text=a%1Bb")!.action).toEqual({ kind: "capture", mode: "text", text: "ab" });
    // Voice mode never adds text directly.
    expect(parseNativeUrl("lumen://capture?mode=voice&text=x")!.action).toEqual({ kind: "capture", mode: "voice", text: null });
  });

  it("applying: text goes straight to the inbox, the rest opens the app's views", async () => {
    const calls: string[] = [];
    const h: NativeHandlers = {
      capture: (mode, t) => void calls.push(`box ${mode} ${t}`),
      captureText: async (text) => void calls.push(`inbox ${text}`),
      newNote: () => void calls.push("new"),
      search: (q) => void calls.push(`search ${q}`),
      daily: () => void calls.push("daily"),
    };
    for (const u of ["lumen://capture?t=1762761900000", "lumen://capture?text=hi", "lumen://new", "lumen://search?q=x", "lumen://daily"]) applyAction(parseNativeUrl(u)!, h);
    await Promise.resolve();
    expect(calls).toEqual(["box text 1762761900000", "inbox hi", "new", "search x", "daily"]);
  });
});

describe("captures queued by Siri / Shortcuts", () => {
  const items = [
    { id: "b", text: "שני", at: "2026-11-10T09:00:00Z" },
    { id: "a", text: "ראשון", at: "2026-11-10T08:00:00Z" },
    { id: "a", text: "כפול", at: "2026-11-10T08:30:00Z" },
    { id: "c", text: "   ", at: "2026-11-10T10:00:00Z" },
    { id: "d", text: "x", at: "not a date" },
    { id: 5, text: "x", at: "2026-11-10T10:00:00Z" },
    "junk",
  ];

  it("keeps well-formed items, oldest first, once each", () => {
    expect(validPending(items).map((p) => p.id)).toEqual(["a", "b"]);
    expect(validPending("nope")).toEqual([]);
  });

  it("adds each with its own time; a failure keeps it and the rest for next time", async () => {
    const added: Array<[string, string]> = [];
    const ok = await drainPending(items, async (t, when) => void added.push([t, when.toISOString()]));
    expect(ok).toEqual(["a", "b"]);
    expect(added).toEqual([["ראשון", "2026-11-10T08:00:00.000Z"], ["שני", "2026-11-10T09:00:00.000Z"]]);
    let n = 0;
    const partial = await drainPending(items, async () => {
      if (n++ === 1) throw new Error("vault closed");
    });
    expect(partial).toEqual(["a"]);
  });

  it("the bridge: the launch link is applied, the queue drained, only added ids removed", async () => {
    const removed: string[][] = [];
    const listeners: Record<string, (e: { url?: string }) => void> = {};
    const plugin: LumenNativePlugin = {
      getLaunchUrl: async () => ({ url: "lumen://daily" }),
      pendingCaptures: async () => ({ items: [{ id: "x", text: "מסירי", at: "2026-11-10T08:00:00Z" }] }),
      removeCaptures: async ({ ids }) => void removed.push(ids),
      addListener: async (ev, fn) => {
        listeners[ev] = fn;
        return { remove: async () => undefined };
      },
    };
    const calls: string[] = [];
    const stop = await initNativeBridge(
      { capture: () => void calls.push("box"), captureText: async (t) => void calls.push(`inbox ${t}`), newNote: () => {}, search: (q) => void calls.push(`search ${q}`), daily: () => void calls.push("daily") },
      plugin,
    );
    expect(calls).toEqual(["daily", "inbox מסירי"]);
    expect(removed).toEqual([["x"]]);
    listeners.url({ url: "lumen://search?q=a" });
    listeners.url({ url: "https://evil.example" });
    expect(calls.at(-1)).toBe("search a");
    stop();
  });
});

describe("tap → typing", () => {
  it("measured from the tap time the app stamped, sane values only", () => {
    expect(tapLatency(1000_000_000_000, 1000_000_000_640)).toBe(640);
    expect(tapLatency(null, 5)).toBe(null);
    expect(tapLatency(2000, 1000)).toBe(null);
    noteTap(Date.now() - 300);
    const ms = tapReady();
    expect(ms !== null && ms >= 300 && ms < 2000).toBe(true);
    expect(tapReady()).toBe(null);
  });
});

describe("the native files", () => {
  const LINKS = ["lumen://search", "lumen://capture", "lumen://daily"];

  it("Android: the widget, App Shortcuts, the lumen:// filter and the plugin are registered", () => {
    const manifest = read("android/app/src/main/AndroidManifest.xml");
    expect(manifest).toContain('android:name=".LumenWidgetProvider"');
    expect(manifest).toContain('android:resource="@xml/widget_lumen_info"');
    expect(manifest).toContain('android:resource="@xml/shortcuts"');
    expect(manifest).toMatch(/<data android:scheme="lumen" \/>/);
    expect(read("android/app/src/main/java/com/lumen/editor/MainActivity.java")).toContain("registerPlugin(LumenNativePlugin.class)");
    const shortcuts = read("android/app/src/main/res/xml/shortcuts.xml");
    for (const l of [...LINKS, "lumen://capture?mode=voice"]) expect(shortcuts).toContain(`android:data="${l}"`);
    const actions = read("android/app/src/main/java/com/lumen/editor/LumenActions.java");
    for (const l of LINKS) expect(actions).toContain(`"${l}"`);
  });

  it("Android widget is RTL-ready: start/end only, Hebrew strings for every English one", () => {
    const layout = read("android/app/src/main/res/layout/widget_lumen.xml");
    expect(layout).not.toMatch(/Left|Right|layout_gravity="(left|right)"/);
    expect(layout).toContain('android:layoutDirection="locale"');
    const names = (x: string) => [...x.matchAll(/<string name="([a-z_]+)"/g)].map((m) => m[1]).filter((n) => /^(widget|shortcut)_/.test(n)).sort();
    const en = names(read("android/app/src/main/res/values/strings.xml"));
    expect(en.length).toBe(12);
    expect(names(read("android/app/src/main/res/values-iw/strings.xml"))).toEqual(en);
    expect(read("android/app/src/main/AndroidManifest.xml")).toContain('android:supportsRtl="true"');
  });

  it("iOS: the scheme, Hebrew, the plugin's view controller, intents and widget links", () => {
    const plist = read("ios/App/App/Info.plist");
    expect(plist).toMatch(/<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>lumen<\/string>/);
    expect(plist).toMatch(/<key>CFBundleLocalizations<\/key>\s*<array>\s*<string>en<\/string>\s*<string>he<\/string>/);
    expect(read("ios/App/App/Base.lproj/Main.storyboard")).toContain('customClass="MainViewController" customModule="App"');
    expect(read("ios/App/App/AppDelegate.swift")).toContain("LumenLaunch.deliver(url)");
    const native = read("ios/App/App/LumenNative.swift");
    expect(native).toContain('jsName = "LumenNative"');
    for (const m of ["getLaunchUrl", "pendingCaptures", "removeCaptures"]) expect(native).toContain(`name: "${m}"`);
    const intents = read("ios/App/App/LumenIntents.swift");
    for (const i of ["AddToInboxIntent", "QuickNoteIntent", "VoiceNoteIntent", "SearchNotesIntent", "DailyNoteIntent", "AppShortcutsProvider"]) expect(intents).toContain(i);
    expect(intents).toMatch(/struct AddToInboxIntent[\s\S]*?openAppWhenRun = false/);
    const widget = read("ios/App/LumenWidgets/LumenWidgets.swift");
    for (const l of LINKS) expect(widget).toContain(`url: "${l}"`);
  });

  it("iOS strings: Hebrew for every English key (widget, intents, Siri phrases)", () => {
    const keys = (x: string) => [...x.matchAll(/^"(.+?)" = /gm)].map((m) => m[1]).sort();
    for (const f of ["ios/App/LumenWidgets/%s.lproj/Localizable.strings", "ios/App/App/%s.lproj/Localizable.strings", "ios/App/App/%s.lproj/AppShortcuts.strings"]) {
      const en = keys(read(f.replace("%s", "en")));
      expect(en.length, f).toBeGreaterThan(3);
      expect(keys(read(f.replace("%s", "he"))), f).toEqual(en);
    }
    // Every Siri phrase in the code has a localization.
    const intents = read("ios/App/App/LumenIntents.swift");
    const phrases = [...intents.matchAll(/"([^"]*\\\(\.applicationName\)[^"]*)"/g)].map((m) => m[1].replace("\\(.applicationName)", "${applicationName}"));
    expect(phrases.length).toBe(8);
    const he = read("ios/App/App/he.lproj/AppShortcuts.strings");
    for (const p of phrases) expect(he, p).toContain(`"${p}" = `);
  });

  it("the docs: user guide and owner steps in English and Hebrew, with the sidebar entry", () => {
    for (const f of ["docs/src/content/docs/editor/widgets.md", "docs/src/content/docs/he/editor/widgets.md"]) {
      const md = read(f);
      for (const s of ["lumen://capture?text=", "Widget Extension", "LumenWidgetProvider", "npx cap sync ios", "npx cap sync android"]) expect(md, `${f}: ${s}`).toContain(s);
    }
    expect(read("docs/astro.config.mjs")).toContain('slug: "editor/widgets"');
  });
});
