/**
 * Hebrew keyboard layout (plan W2.8): wrong-layout text is read both ways,
 * 50 golden wrong-layout queries find the right command in the top 3, every
 * shortcut works in the English and the Hebrew layout, and no two collide.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { activeLayout, matchShortcut, noteTypedKey, resetLayoutMemory, shortcutKey, toHebrewLayout, toLatinLayout, wrongLayoutVariant } from "../lib/keyboardLayout";
import { appShortcutFor, formatCombo, SHORTCUTS } from "../lib/shortcuts";
import { mergeLayoutHits, rankCommands } from "../ui/paletteSearch";
import { readLocale } from "../../scripts/lib/i18n-files.mjs";

/** [typed with the wrong layout, what was meant, the command it should find]. */
const GOLDEN: Array<[string, string, string]> = [
  ["anhrv", "שמירה", "file.save"],
  ["p,hj,", "פתיחת", "file.open"],
  ["vspxv", "הדפסה", "file.print"],
  ["nxnl jsa", "מסמך חדש", "file.new"],
  ["jhpua", "חיפוש", "view.search"],
  ["jhpua uvjkpv", "חיפוש והחלפה", "view.findReplace"],
  ["dr;", "גרף", "view.graphView"],
  ["vhxyurhh,", "היסטוריית", "view.versionHistory"],
  ["vuxp, yckv", "הוספת טבלה", "insert.table"],
  ["vuxp, npv", "הוספת מפה", "insert.map"],
  ["vuxp, ckue n,nyh", "הוספת בלוק מתמטי", "insert.math"],
  ["ebcx", "קנבס", "view.canvas"],
  ["dkrhh, ,uxpho", "גלריית תוספים", "view.plugins"],
  ["vmpb,", "הצפנת", "vault.encrypt"],
  ["pgbuj", "פענוח", "vault.decrypt"],
  ["ghmuc vnxnl", "עיצוב המסמך", "edit.formatDocument"],
  [",rduo", "תרגום", "ai.translate"],
  ["nmc neur", "מצב מקור", "view.source"],
  ["nmc npumk", "מצב מפוצל", "view.split"],
  [",mudv neshnv", "תצוגה מקדימה", "view.preview"],
  ["xk vnjzur", "סל המחזור", "file.trash"],
  ["vertv", "הקראה", "note.read"],
  ["nrjc gcusv", "מרחב עבודה", "view.workspace"],
  ["fhuui yexy", "כיוון טקסט", "view.rtl"],
  [",zfhr eukh", "תזכיר קולי", "voice.memo"],
  ["דשהק", "save", "file.save"],
  ["םפקמ", "open", "file.open"],
  ["פרןמא", "print", "file.print"],
  ["מק' גםבוצקמא", "new document", "file.new"],
  ["דקשרבי", "search", "view.search"],
  ["כןמג", "find", "view.findReplace"],
  ["ערשפי", "graph", "view.graphView"],
  ["הקרדןםמ", "version", "view.versionHistory"],
  ["ןמדקרא אשנךק", "insert table", "insert.table"],
  ["ןמדקרא צשפ", "insert map", "insert.map"],
  ["בשמהשד", "canvas", "view.canvas"],
  ["פךועןמ", "plugin", "view.plugins"],
  ["קמברטפא", "encrypt", "vault.encrypt"],
  ["גקברטפא", "decrypt", "vault.decrypt"],
  ["כםרצשא גםבוצקמא", "format document", "edit.formatDocument"],
  ["ארשמדךשאק", "translate", "ai.translate"],
  ["דםורבק", "source", "view.source"],
  ["דפךןא", "split", "view.split"],
  ["פרקהןק'", "preview", "view.preview"],
  ["ארשדי", "trash", "file.trash"],
  ["רקשג שךםוג", "read aloud", "note.read"],
  ["'םרלדפשבק", "workspace", "view.workspace"],
  ["ראך", "rtl", "view.rtl"],
  ["הםןבק צקצם", "voice memo", "voice.memo"],
  ["םואךןמק", "outline", "view.outline"],
];

/** The palette's commands in English and in Hebrew (labels from the i18n bundles). */
function corpus(): Array<{ id: string; label: string; hint?: string; group?: string }> {
  const snap = JSON.parse(readFileSync(join(__dirname, "__snapshots__", "commandIds.snapshot.json"), "utf8")) as { minimal: Array<{ id: string; label: string; hint?: string; group?: string }> };
  // The English and Hebrew bundles, per domain (src/i18n/locales/<lang>/*.json).
  const byValue = new Map<string, string>();
  for (const [k, v] of Object.entries(readLocale("en"))) if (!byValue.has(v)) byValue.set(v, k);
  const he = readLocale("he");
  const tr = (s?: string) => (s === undefined ? undefined : (he[byValue.get(s) ?? ""] ?? s));
  return [...snap.minimal, ...snap.minimal.map((c) => ({ id: c.id, label: tr(c.label) ?? c.label, hint: tr(c.hint), group: tr(c.group) }))];
}

describe("wrong keyboard layout (W2.8)", () => {
  it("reads text both ways", () => {
    expect(toHebrewLayout("akuo")).toBe("שלום");
    expect(toLatinLayout("יקךךם")).toBe("hello");
    expect(wrongLayoutVariant("akuo")).toBe("שלום");
    expect(wrongLayoutVariant("יקךךם")).toBe("hello");
    expect(wrongLayoutVariant("שלום world")).toBeNull();
    expect(wrongLayoutVariant("123")).toBeNull();
    expect(wrongLayoutVariant("")).toBeNull();
  });

  it("the golden strings are what the standard Israeli layout types", () => {
    for (const [typed, meant] of GOLDEN) expect(/[a-z]/.test(meant) ? toLatinLayout(typed) : toHebrewLayout(typed), typed).toBe(meant);
  });

  it("50 golden wrong-layout queries: the right command is in the top 3 in at least 95%", () => {
    const list = corpus();
    expect(GOLDEN).toHaveLength(50);
    const misses: string[] = [];
    for (const [typed, meant, id] of GOLDEN) {
      const r = rankCommands(list, typed);
      const top = [...new Set(r.items.map((c) => c.id))].slice(0, 3);
      if (!top.includes(id)) misses.push(`${typed} (${meant}) → ${top.join(", ")}`);
      else expect(r.variant, typed).toBe(meant.toLowerCase());
    }
    expect(misses.length, misses.join("\n")).toBeLessThanOrEqual(2);
  });

  it("what was typed ranks above the other-layout reading", () => {
    const list = [{ label: "Save" }, { label: "דשהק thing" }];
    expect(rankCommands(list, "דשהק").items.map((c) => c.label)).toEqual(["דשהק thing", "Save"]);
  });

  it("search merges other-layout hits after the direct ones, without duplicates", () => {
    expect(mergeLayoutHits([{ path: "a.md" }], [{ path: "a.md" }, { path: "b.md" }]).map((h) => h.path)).toEqual(["a.md", "b.md"]);
  });
});

/** The event a key press gives in each layout: US, and Hebrew (SI 1452). */
function events(combo: string): Array<{ layout: string; e: Parameters<typeof matchShortcut>[0] }> {
  const parts = combo.split("+");
  const last = parts.pop()!;
  // A function key (F1) is the same key in every layout.
  if (/^F\d{1,2}$/.test(last)) return ["US", "Hebrew", "macOS ⌘"].map((layout) => ({ layout, e: { key: last, code: last, ctrlKey: false, shiftKey: false, altKey: false } }));
  const key = last === "Space" ? " " : last.toLowerCase();
  const code = key === " " ? "Space" : /[a-z]/.test(key) ? `Key${key.toUpperCase()}` : /[0-9]/.test(key) ? `Digit${key}` : key === "/" ? "Slash" : "";
  const mods = { ctrlKey: parts.includes("Mod") || parts.includes("Ctrl"), shiftKey: parts.includes("Shift"), altKey: parts.includes("Alt") };
  const heKey = toHebrewLayout(key);
  return [
    { layout: "US", e: { key: mods.shiftKey && /[a-z]/.test(key) ? key.toUpperCase() : key, code, ...mods } },
    { layout: "Hebrew", e: { key: heKey, code, ...mods } },
    { layout: "macOS ⌘", e: { key: heKey, code, ...mods, ctrlKey: parts.includes("Ctrl"), metaKey: parts.includes("Mod") } },
  ];
}

describe("shortcuts in both layouts (W2.8)", () => {
  for (const s of SHORTCUTS) {
    it(`${s.id} (${s.combo}) works in the US and the Hebrew layout`, () => {
      for (const { layout, e } of events(s.combo)) {
        if (layout === "macOS ⌘" && s.combo.startsWith("Ctrl+")) continue;
        expect(matchShortcut(e, s.combo), `${layout} ${JSON.stringify(e)}`).toBe(true);
        if (s.scope === "app") expect(appShortcutFor(e), layout).toBe(s.id);
      }
    });
  }

  it("Q in the Hebrew layout types \"/\" but is not Ctrl+/; the / key types \".\" and is", () => {
    expect(shortcutKey({ key: "/", code: "KeyQ", ctrlKey: true })).toBe("q");
    expect(appShortcutFor({ key: "/", code: "KeyQ", ctrlKey: true })).toBeNull();
    expect(appShortcutFor({ key: ".", code: "Slash", ctrlKey: true })).toBe("help.shortcuts");
  });

  it("AltGr (Ctrl+Alt) never fires an App shortcut", () => {
    expect(appShortcutFor({ key: "k", code: "KeyK", ctrlKey: true, altKey: true })).toBeNull();
  });

  it("0 conflicts: every combo is bound once", () => {
    const norm = (c: string) => c.split("+").map((p) => p.toLowerCase()).sort().join("+");
    const seen = new Map<string, string>();
    const dup: string[] = [];
    for (const s of SHORTCUTS) {
      const k = norm(s.combo);
      if (seen.has(k)) dup.push(`${s.combo}: ${seen.get(k)} and ${s.id}`);
      seen.set(k, s.id);
    }
    expect(dup).toEqual([]);
  });

  it("every shortcut the palette shows is the one the app binds", () => {
    const snap = JSON.parse(readFileSync(join(__dirname, "__snapshots__", "commandIds.snapshot.json"), "utf8")) as { full: Array<{ id: string; shortcut?: string }> };
    const toCombo = (s: string) => {
      if (s.includes("+")) return s;
      const key = s.replace(/[⌘⇧⌥⌃]/g, "");
      return [s.includes("⌘") ? "Mod" : null, s.includes("⇧") ? "Shift" : null, s.includes("⌥") ? "Alt" : null, key].filter(Boolean).join("+");
    };
    const wrong: string[] = [];
    for (const c of snap.full) {
      if (!c.shortcut) continue;
      const combo = toCombo(c.shortcut);
      const bound = SHORTCUTS.find((s) => s.combo.toLowerCase() === combo.toLowerCase());
      if (!bound || bound.id !== c.id) wrong.push(`${c.id} shows ${c.shortcut}, which is ${bound?.id ?? "not bound"}`);
    }
    expect(wrong).toEqual([]);
  });

  it("formats combos per platform", () => {
    expect(formatCombo("Mod+Shift+F", true)).toBe("⌘⇧F");
    expect(formatCombo("Mod+K", false)).toBe("Ctrl+K");
  });
});

describe("active layout (W2.8)", () => {
  beforeEach(() => resetLayoutMemory());
  it("follows what is typed, else the UI language", () => {
    expect(activeLayout("he")).toBe("he");
    expect(activeLayout("en")).toBe("latin");
    noteTypedKey("ש");
    expect(activeLayout("en")).toBe("he");
    noteTypedKey("a");
    expect(activeLayout("he")).toBe("latin");
  });
});
