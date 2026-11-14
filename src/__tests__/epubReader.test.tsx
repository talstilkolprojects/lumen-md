/**
 * Plan W1.14 — the EPUB reader, rendered: a Hebrew book opens right-to-left
 * at its first chapter, a selection becomes a highlight saved in
 * `<book>.epub.md`, and the link to it reopens the book at that chapter with
 * the highlight marked; reading settings stick to the book.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { makeEpub } from "./helpers/epubFixture";
import { EpubReader } from "../epub/EpubReader";
import { readEpubNote, describeEpubAnnotation } from "../epub/annotations";
import { readWorkspaceFile, writeWorkspaceBlob } from "../storage/workspace";
import { shortId } from "../pdf/annotations";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function until<T>(fn: () => T | null | undefined | false, ms = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout waiting");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

const BOOK = "books/he-test.epub";

describe("EPUB reader UI (W1.14)", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(async () => {
    localStorage.clear();
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await writeWorkspaceBlob(BOOK, await makeEpub({ hebrew: true, deflate: true }));
  });

  it("opens RTL, highlights a selection into the companion note, and the link reopens it there", async () => {
    await act(async () => root.render(createElement(EpubReader, { path: BOOK, onClose: () => undefined })));
    const chapter = await until(() => host.querySelector<HTMLElement>(".epub-chapter h1")?.closest<HTMLElement>(".epub-chapter"));
    expect(chapter.getAttribute("dir")).toBe("rtl");
    expect(host.querySelector(".epub-title")?.textContent).toContain("ספר בדיקה");
    expect(chapter.querySelector("img")?.getAttribute("src")?.startsWith("data:image/png")).toBe(true);
    expect(chapter.querySelectorAll("img").length).toBe(1); // the remote image is gone

    // Select "משפט ראשון" in the first paragraph and highlight it.
    const p = chapter.querySelector("p")!;
    const text = p.firstChild as Text;
    const at = text.data.indexOf("משפט ראשון");
    const range = document.createRange();
    range.setStart(text, at);
    range.setEnd(text, at + "משפט ראשון".length);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    const button = await until(() => Array.from(host.querySelectorAll<HTMLButtonElement>(".epub-toolbar button")).find((b) => b.textContent === "Highlight" && !b.disabled));
    await act(async () => button.click());
    await until(() => chapter.querySelector("mark.epub-hl"));
    expect(chapter.querySelector("mark.epub-hl")?.textContent).toBe("משפט ראשון");

    let md = "";
    await until(() => {
      void readWorkspaceFile(`${BOOK}.md`).then((s) => (md = s), () => undefined);
      return md.includes("lumen-epub-annotations") && md;
    });
    const list = readEpubNote(md)!;
    expect(list).toHaveLength(1);
    expect(describeEpubAnnotation(list[0])).toMatchObject({ chapter: 1, quote: { exact: "משפט ראשון" } });
    expect(md).toContain(`[[${BOOK}#chapter=1&highlight=${shortId(list[0].id)}|`);

    // Go to chapter 2, then follow the highlight link: back at chapter 1, marked and flashed.
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>(".epub-nav button"))[1].click());
    await until(() => host.querySelector(".epub-chapter h1")?.textContent === "פרק שני");
    await act(async () => root.render(createElement(EpubReader, { path: BOOK, fragment: `chapter=1&highlight=${shortId(list[0].id)}`, openSeq: 1, onClose: () => undefined })));
    await until(() => host.querySelector(".epub-chapter h1")?.textContent === "פרק ראשון");
    const mark = await until(() => host.querySelector(`mark[data-highlight="${shortId(list[0].id)}"]`));
    await until(() => mark.classList.contains("epub-hl-flash") || host.querySelector(".epub-hl-flash"));
    await act(async () => root.unmount());
  });

  it("keeps the theme, font size and chapter per book", async () => {
    await act(async () => root.render(createElement(EpubReader, { path: BOOK, onClose: () => undefined })));
    await until(() => host.querySelector(".epub-chapter h1"));
    const btn = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>(".epub-toolbar button")).find((b) => b.textContent === label || b.getAttribute("aria-label") === label)!;
    await act(async () => btn("Sepia").click());
    await act(async () => btn("Larger text").click());
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>(".epub-nav button"))[1].click());
    await until(() => host.querySelector(".epub-chapter h1")?.textContent === "פרק שני");
    expect(host.querySelector(".epub-reader")?.classList.contains("epub-theme-sepia")).toBe(true);
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(EpubReader, { path: BOOK, onClose: () => undefined })));
    await until(() => host.querySelector(".epub-chapter h1")?.textContent === "פרק שני");
    expect(host.querySelector(".epub-reader")?.classList.contains("epub-theme-sepia")).toBe(true);
    expect((host.querySelector(".epub-reader") as HTMLElement).style.getPropertyValue("--epub-size")).toBe("20px");
    await act(async () => root.unmount());
  });
});
