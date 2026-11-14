import { test, expect, type Page } from "@playwright/test";

/**
 * Embeds (plan 4.7) — `![[note]]`, `![[note#heading]]`, `![[image.png|40]]`
 * in the live preview: the embedded note renders in place, only the named
 * section for `#heading`, images come from the vault, a cycle and a missing
 * target show a notice, a Hebrew note embedded in an English one is
 * right-to-left, and saving the embedded note updates the embed.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

/** Write vault files straight into OPFS; false where this engine can't. */
async function seed(page: Page, files: Record<string, string>): Promise<boolean> {
  return page.evaluate(async (files) => {
    try {
      const root = await navigator.storage.getDirectory();
      for (const [name, data] of Object.entries(files)) {
        const fh = (await root.getFileHandle(name, { create: true })) as unknown as {
          createWritable?: () => Promise<{ write(d: BufferSource | string): Promise<void>; close(): Promise<void> }>;
        };
        if (typeof fh.createWritable !== "function") return false;
        const w = await fh.createWritable();
        // `data:` prefix marks base64 binary content.
        await w.write(data.startsWith("data:") ? Uint8Array.from(atob(data.slice(5)), (c) => c.charCodeAt(0)) : data);
        await w.close();
      }
      return true;
    } catch {
      return false;
    }
  }, files);
}

const PIXEL = "data:iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("embeds render notes, sections and images, guard cycles, and update live", async ({ page }) => {
  const ok = await seed(page, {
    "Embedded Source.md": "# Source\n\nfirst version of the source\n\n## Part\n\nonly this part",
    "Loop A.md": "A body\n\n![[Loop B]]",
    "Loop B.md": "B body\n\n![[Loop A]]",
    // ASCII file name: this headless Chromium crashes creating OPFS files
    // with Hebrew names (Hebrew names are covered by the unit tests).
    "Hebrew note.md": "שלום עולם, זה פתק בעברית.",
    "pixel.png": PIXEL,
  });
  test.skip(!ok, "this engine cannot write OPFS files here");
  // The vault changed behind the app's back: let the workspace index know.
  await page.evaluate(() => window.dispatchEvent(new Event("lumen-workspace-changed")));

  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await editor.fill(
    "# Host note\n\n![[Embedded Source]]\n\n![[Embedded Source#Part]]\n\n![[pixel.png|40]]\n\n![[Loop A]]\n\n![[Hebrew note]]\n\n![[Nowhere]]\n",
  );

  const preview = page.locator("[data-preview-root]").first();
  const whole = preview.locator('.lumen-embed[data-embed-target="Embedded Source"]');
  await expect(whole).toContainText("first version of the source", { timeout: 10_000 });

  const section = preview.locator('.lumen-embed[data-embed-target="Embedded Source#Part"] .lumen-embed-body');
  await expect(section).toContainText("only this part");
  await expect(section).not.toContainText("first version");

  const img = preview.locator("img.lumen-embed-image");
  await expect(img).toHaveAttribute("src", /^blob:/);
  await expect(img).toHaveAttribute("width", "40");

  await expect(preview.locator('[data-embed-status="cycle"]')).toBeVisible();
  await expect(preview.locator('[data-embed-status="notFound"]')).toContainText("Nowhere");

  // RTL: the Hebrew embed runs right-to-left, its bar on the right.
  const hebrew = preview.locator('.lumen-embed[data-embed-target="Hebrew note"]');
  await expect(hebrew).toContainText("שלום עולם");
  const box = await hebrew.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { dir: cs.direction, right: cs.borderRightWidth, left: cs.borderLeftWidth };
  });
  expect(box).toEqual({ dir: "rtl", right: "3px", left: "0px" });

  // Saving the embedded note updates the embed.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle("Embedded Source.md");
    const w = await (fh as unknown as { createWritable(): Promise<{ write(d: string): Promise<void>; close(): Promise<void> }> }).createWritable();
    await w.write("# Source\n\nsecond version of the source\n\n## Part\n\nonly this part");
    await w.close();
    window.dispatchEvent(new CustomEvent("lumen-workspace-changed", { detail: { kind: "content", paths: ["Embedded Source.md"] } }));
  });
  await expect(whole).toContainText("second version of the source", { timeout: 10_000 });
});
