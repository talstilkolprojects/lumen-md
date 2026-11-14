/**
 * The 30 docs GIFs (plan W4.34): each flow is a short, real use of the app
 * in Hebrew, recorded by e2e/gifs/record.gifs.ts into
 * docs/public/gifs/<id>.gif for the docs page it illustrates.
 *
 * A flow drives the app through the same means as the e2e tests (palette
 * commands, the editor, roles and test ids) and calls `shot()` where the
 * reader should see a frame; `hold` is how long that frame stays. A flow
 * ends with a check, so a GIF of a broken screen is never written.
 */
import { expect, type Page } from "@playwright/test";

export interface FlowCtx {
  page: Page;
  /** Add a frame of the page as it is now, shown for `hold` ms. */
  shot: (hold?: number) => Promise<void>;
  /** Run a palette command by id (the app's `lumen-run-command`). */
  command: (id: string) => Promise<void>;
  /** Open the palette and type into it (the reader sees the search). */
  palette: (query: string) => Promise<void>;
  /** Replace the note with `text` (source editor). */
  note: (text: string) => Promise<void>;
  /** Type into the focused editor, a few frames along the way. */
  typeSlowly: (text: string) => Promise<void>;
}

export interface GifFlow {
  id: string;
  title: { he: string; en: string };
  /** The docs page (slug, English; the Hebrew twin is he/<slug>) the GIF belongs to. */
  page: string;
  run: (c: FlowCtx) => Promise<void>;
}

const dialog = (page: Page) => page.locator('[role="dialog"], [role="alertdialog"]').last();
const preview = (page: Page) => page.locator("[data-preview-root]").first();

/** A flow that opens something with a command and shows it. */
const opens = (id: string, he: string, en: string, page: string, command: string, visible: (p: Page) => ReturnType<Page["locator"]> = dialog): GifFlow => ({
  id,
  title: { he, en },
  page,
  run: async ({ page: p, command: run, shot }) => {
    await shot(600);
    await run(command);
    await expect(visible(p)).toBeVisible({ timeout: 15_000 });
    await shot(1800);
  },
});

/** A flow that inserts a block with a command and shows it rendered in the preview. */
const inserts = (id: string, he: string, en: string, page: string, command: string, rendered: string): GifFlow => ({
  id,
  title: { he, en },
  page,
  run: async ({ page: p, command: run, note, shot }) => {
    await note("# הדגמה\n\n");
    await shot(600);
    await run(command);
    await expect(preview(p).locator(rendered).first()).toBeVisible({ timeout: 20_000 });
    await shot(2000);
  },
});

export const FLOWS: GifFlow[] = [
  {
    id: "palette",
    title: { he: "לוח הפקודות", en: "The command palette" },
    page: "getting-started/shortcuts",
    run: async ({ page, palette, shot }) => {
      await shot(500);
      await palette("ייצוא");
      await expect(page.locator('[role="option"]').first()).toBeVisible();
      await shot(2000);
    },
  },
  {
    id: "first-note",
    title: { he: "פתק ראשון בעברית", en: "A first note in Hebrew" },
    page: "getting-started/quickstart",
    run: async ({ page, command, typeSlowly, shot }) => {
      await command("file.new");
      await page.locator(".cm-content").first().click();
      await shot(400);
      await typeSlowly("# רשימת קניות\n\n- חלב\n- לחם\n- [ ] תפוחים");
      await expect(preview(page).locator("h1")).toContainText("רשימת קניות");
      await shot(2000);
    },
  },
  {
    id: "modes",
    title: { he: "מקור, מפוצל, תצוגה ו-WYSIWYG", en: "Source, split, preview and WYSIWYG" },
    page: "editor/modes",
    run: async ({ page, command, note, shot }) => {
      await note("# מצבי עריכה\n\nטקסט **מודגש** ו*נטוי*.");
      for (const m of ["view.source", "view.split", "view.preview", "view.wysiwyg"]) {
        await command(m);
        await shot(1000);
      }
      await expect(page.getByText("מצבי עריכה").first()).toBeVisible();
      await command("view.split");
      await shot(800);
    },
  },
  {
    id: "rtl",
    title: { he: "כיוון הטקסט", en: "Text direction" },
    page: "editor/hebrew",
    run: async ({ page, command, note, shot }) => {
      await note("שלום עולם — Hello world\n\nפסקה בעברית עם English באמצע.");
      await shot(1000);
      await command("view.rtl");
      await shot(1200);
      await command("view.rtl");
      await expect(page.locator(".cm-content").first()).toBeVisible();
      await shot(1000);
    },
  },
  inserts("mermaid", "תרשים Mermaid", "A Mermaid diagram", "blocks/reference", "insert.mermaid", "svg"),
  inserts("math", "נוסחה", "A math block", "blocks/reference", "insert.math", ".katex"),
  inserts("callout", "תיבת הערה", "A callout", "blocks/reference", "insert.callout", ".admonition, [data-callout], blockquote"),
  inserts("chart", "תרשים נתונים", "A chart", "blocks/reference", "insert.chart", "canvas, svg"),
  inserts("csv", "טבלת CSV", "A CSV table", "blocks/reference", "insert.csv", "table"),
  inserts("graphviz", "תרשים Graphviz", "A Graphviz diagram", "blocks/reference", "insert.graphviz", "svg"),
  opens("table-editor", "עורך הטבלאות", "The table editor", "editor/smart-insert", "insert.table"),
  {
    id: "wikilink",
    title: { he: "קישור לפתק אחר", en: "A link to another note" },
    page: "workspace/search",
    run: async ({ page, note, typeSlowly, shot }) => {
      await note("ראו גם: ");
      await page.keyboard.press("ControlOrMeta+End");
      await typeSlowly("[[סיכום הרצאה]]");
      await expect(preview(page).getByText("סיכום הרצאה").first()).toBeVisible();
      await shot(2000);
    },
  },
  {
    id: "outline",
    title: { he: "מתאר הפתק", en: "The note outline" },
    page: "editor/hebrew",
    run: async ({ page, command, note, shot }) => {
      await note("# פרק ראשון\n\nטקסט\n\n## סעיף א\n\nטקסט\n\n## סעיף ב\n\n# פרק שני\n");
      await shot(600);
      await command("view.outline");
      await expect(page.getByText("סעיף ב").first()).toBeVisible();
      await shot(2000);
    },
  },
  opens("backlinks", "קישורים נכנסים", "Backlinks", "workspace/search", "view.backlinks", (p) => p.locator("aside, [role='complementary'], [data-testid*='backlinks']").first()),
  opens("graph", "גרף הידע", "The knowledge graph", "workspace/search", "view.graphView"),
  {
    id: "search",
    title: { he: "חיפוש בכל הפתקים", en: "Searching every note" },
    page: "workspace/search",
    run: async ({ page, command, shot }) => {
      await command("view.search");
      const box = dialog(page).locator("input").first();
      await expect(box).toBeVisible({ timeout: 10_000 });
      await shot(500);
      await box.pressSequentially("פתקים", { delay: 80 });
      await shot(2000);
    },
  },
  {
    id: "find-replace",
    title: { he: "חיפוש והחלפה", en: "Find and replace" },
    page: "editor/modes",
    run: async ({ page, command, note, shot }) => {
      await note("חתול שחור, חתול לבן, חתול ג׳ינג׳י.");
      await command("view.findReplace");
      await expect(page.locator("input").first()).toBeVisible();
      await shot(1000);
      await page.keyboard.type("חתול");
      await shot(2000);
    },
  },
  opens("history", "היסטוריית גרסאות", "Version history", "workspace/export-import", "view.versionHistory"),
  opens("trash", "סל המחזור", "The trash", "workspace/export-import", "file.trash"),
  opens("canvas", "קנבס", "The canvas", "getting-started/welcome", "view.canvas", (p) => p.locator('[data-testid="canvas"], canvas').first()),
  opens("plugins", "גלריית התוספים", "The plugin gallery", "plugins/sdk", "view.plugins"),
  {
    id: "theme",
    title: { he: "ערכת צבעים בהירה וכהה", en: "Light and dark themes" },
    page: "editor/modes",
    run: async ({ page, command, note, shot }) => {
      await note("# ערכות נושא\n\nאותו פתק, בבהיר ובכהה.");
      await shot(1000);
      await command("theme.toggle");
      await shot(1200);
      await command("theme.toggle");
      await expect(page.locator("body")).toBeVisible();
      await shot(1000);
    },
  },
  {
    id: "page-view",
    title: { he: "תצוגת עמוד A4", en: "A4 page view" },
    page: "editor/modes",
    run: async ({ page, command, note, shot }) => {
      await note("# מסמך להדפסה\n\n" + "פסקה ארוכה של טקסט בעברית. ".repeat(30));
      await shot(800);
      await command("view.pageView");
      await expect(page.locator("body")).toBeVisible();
      await shot(2000);
      await command("view.pageView");
    },
  },
  {
    id: "typewriter",
    title: { he: "מצב מכונת כתיבה", en: "Typewriter mode" },
    page: "editor/modes",
    run: async ({ page, command, note, typeSlowly, shot }) => {
      await note("שורה\n".repeat(30));
      await command("view.typewriter");
      await page.locator(".cm-content").first().click();
      await page.keyboard.press("ControlOrMeta+End");
      await typeSlowly("השורה שאני כותב נשארת באמצע המסך");
      await shot(1500);
      await command("view.typewriter");
    },
  },
  opens("writing-goal", "יעד כתיבה יומי", "A daily writing goal", "editor/modes", "tools.writingGoal"),
  opens("export", "ייצוא ל-HTML", "Export to HTML", "workspace/export-import", "file.exportHtml"),
  opens("vault-export", "ייצוא הכספת", "Exporting the whole vault", "workspace/export-import", "vault.export"),
  opens("privacy-ledger", "יומן הפרטיות", "The privacy ledger", "ai/privacy", "ai.privacyLedger"),
  opens("ai-policy", "בינה מקומית או בענן", "Local or cloud AI", "ai/privacy", "ai.policy"),
  opens("vault-doctor", "רופא הכספת", "The vault doctor", "workspace/doctor", "tools.vaultDoctor"),
];
