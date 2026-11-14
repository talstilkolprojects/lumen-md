/**
 * Hover preview (4.6): what part of a note the card shows, how fast it
 * renders, the card's accessibility, and the unlinked-mentions section with
 * its Link button.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installFakeOpfs } from "./helpers/fakeOpfs";
import { readWorkspaceFile, writeWorkspaceFile } from "../storage/workspace";
import { __resetWorkspaceIndex, ensureIndex } from "../storage/workspaceIndex";
import { HoverCard, PREVIEW_LINES, previewMarkdown, renderPreview } from "../renderer/hoverPreview";
import UnlinkedMentions, { unlinkedMentionsOf } from "../ui/UnlinkedMentions";

vi.mock("../ui/AiToast", () => ({ showAiToast: vi.fn() }));

const LONG = ["---", "title: x", "---", "# Plans", ...Array.from({ length: 40 }, (_, i) => `Line ${i + 1}.`), "", "## Later", "", "Later text. ^later", "", "## Later", "", "second later"].join("\n");

beforeAll(async () => {
  installFakeOpfs();
  __resetWorkspaceIndex();
  await writeWorkspaceFile("Plans.md", LONG);
  await writeWorkspaceFile("Tel Aviv.md", "# Tel Aviv\n");
  await writeWorkspaceFile("Trip.md", "We flew to tel aviv, then [[Tel Aviv]] again. `Tel Aviv` in code.\n");
  await writeWorkspaceFile("Other.md", "Tel Aviv Port is not Tel Aviv itself.\n");
  await writeWorkspaceFile("Tel Aviv Port.md", "# Port\n");
  await ensureIndex(true);
});
afterEach(() => cleanup());

describe("previewMarkdown", () => {
  it("the first 20 lines, without front matter", () => {
    const md = previewMarkdown(LONG, null);
    expect(md.split("\n")).toHaveLength(PREVIEW_LINES);
    expect(md.startsWith("# Plans\nLine 1.")).toBe(true);
    expect(md).not.toContain("title: x");
  });

  it("from a heading (numbered like the preview), or just the block", () => {
    expect(previewMarkdown(LONG, "Later").startsWith("## Later\n\nLater text.")).toBe(true);
    expect(previewMarkdown(LONG, "later-1")).toBe("## Later\n\nsecond later");
    expect(previewMarkdown(LONG, "^later")).toBe("Later text. ^later");
    expect(previewMarkdown(LONG, "Nope").startsWith("# Plans")).toBe(true);
  });
});

describe("renderPreview", () => {
  it("renders the note, from cache the second time; well under 150 ms", async () => {
    const t0 = performance.now();
    const first = await renderPreview("Plans");
    const cold = performance.now() - t0;
    const t1 = performance.now();
    const again = await renderPreview("Plans");
    const warm = performance.now() - t1;
    expect(again).toBe(first);
    // hygiene-allow: benchmark output
    console.log(`hover preview render: first ${cold.toFixed(1)} ms, cached ${warm.toFixed(2)} ms`);
    expect(warm).toBeLessThan(150);
    expect(await renderPreview("Nowhere")).toBeNull();
    const { container } = render(first!);
    expect(container.querySelector("h1")?.textContent).toBe("Plans");
    expect(container.textContent).toContain("Line 19.");
    expect(container.textContent).not.toContain("Line 20.");
  });
});

describe("HoverCard", () => {
  it("describes the link while it shows, and says when the note doesn't exist", async () => {
    const card = new HoverCard();
    const a = document.createElement("a");
    document.body.appendChild(a);
    await card.show(a, "Plans#^later");
    expect(card.visible).toBe(true);
    expect(card.el.getAttribute("role")).toBe("tooltip");
    expect(a.getAttribute("aria-describedby")).toBe(card.el.id);
    await waitFor(() => expect(card.el.textContent).toContain("Later text."));
    card.hide();
    expect(a.hasAttribute("aria-describedby")).toBe(false);
    await card.show(a, "Nowhere");
    await waitFor(() => expect(card.el.textContent).toContain("No note named “Nowhere” yet"));
    card.destroy();
  });
});

describe("unlinked mentions", () => {
  it("finds plain-text mentions of the note in other notes, not links, code or longer titles", async () => {
    const files = [
      { path: "Tel Aviv.md", content: "# Tel Aviv\n" },
      { path: "Trip.md", content: await readWorkspaceFile("Trip.md") },
      { path: "Other.md", content: await readWorkspaceFile("Other.md") },
      { path: "Tel Aviv Port.md", content: "# Port\n" },
    ];
    expect(unlinkedMentionsOf("Tel Aviv.md", files).map((h) => [h.path, h.mention.text])).toEqual([
      ["Trip.md", "tel aviv"],
      ["Other.md", "Tel Aviv"],
    ]);
  });

  it("the Link button links that mention in the file, with the text as written for its label", async () => {
    render(<UnlinkedMentions filePath="Tel Aviv.md" onOpen={() => {}} />);
    const section = await screen.findByTestId("unlinked-mentions");
    const button = await within(section).findByRole("button", { name: "Link “tel aviv” in Trip" });
    fireEvent.click(button);
    await waitFor(async () => expect(await readWorkspaceFile("Trip.md")).toBe("We flew to [[Tel Aviv|tel aviv]], then [[Tel Aviv]] again. `Tel Aviv` in code.\n"));
  });
});

describe("review fixes (PR #250)", () => {
  it("a heading-like line in code doesn't shift where a heading's card starts", () => {
    const md = "# Top\n\n```\n# example\n```\n\n> ## Quoted\n\n## Actual\n\ntext\n";
    expect(previewMarkdown(md, "Actual").startsWith("## Actual\n\ntext")).toBe(true);
    expect(previewMarkdown(md, "Quoted").startsWith("> ## Quoted")).toBe(true);
  });

  it("the editor's hover skips [[links]] inside code", async () => {
    const { EditorState } = await import("@codemirror/state");
    const { EditorView } = await import("@codemirror/view");
    const { markdown } = await import("@codemirror/lang-markdown");
    const { wikiHoverSource } = await import("../editor/wikiHover");
    const doc = "Real [[Plans]] and `[[Plans]]` in code.\n\n```\n[[Plans]]\n```\n";
    const view = new EditorView({ state: EditorState.create({ doc, extensions: [markdown()] }) });
    expect(await wikiHoverSource(view, doc.indexOf("[[Plans]]") + 3)).not.toBeNull();
    expect(await wikiHoverSource(view, doc.indexOf("`[[Plans]]`") + 4)).toBeNull();
    expect(await wikiHoverSource(view, doc.lastIndexOf("[[Plans]]") + 3)).toBeNull();
    view.destroy();
  });

  it("Link also updates the note's copy in an inactive tab", async () => {
    const { useAppStore } = await import("../store/useStore");
    await writeWorkspaceFile("Tabbed.md", "Off to Tel Aviv soon.\n");
    await ensureIndex(true);
    useAppStore.setState((s) => ({
      doc: { ...s.doc, workspaceName: "Tel Aviv.md", content: "# Tel Aviv\n" },
      openTabs: [{ id: "Tabbed.md", name: "Tabbed.md", content: "Off to Tel Aviv soon.\n", workspaceName: "Tabbed.md", dirty: false }],
    }));
    render(<UnlinkedMentions filePath="Tel Aviv.md" onOpen={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Link “Tel Aviv” in Tabbed" }));
    await waitFor(async () => expect(await readWorkspaceFile("Tabbed.md")).toBe("Off to [[Tel Aviv]] soon.\n"));
    expect(useAppStore.getState().openTabs[0].content).toBe("Off to [[Tel Aviv]] soon.\n");
    useAppStore.setState({ openTabs: [] });
  });

  it("a block id: not one in code, and just the list item it marks", () => {
    const md = "Intro.\n\n```\nexample ^b1\n```\n\nUses `x ^b1` inline.\n\nThe real one. ^b1\n\n- first\n- second\n- third ^li\n- fourth\n";
    expect(previewMarkdown(md, "^b1")).toBe("The real one. ^b1");
    expect(previewMarkdown(md, "^li")).toBe("- third ^li");
  });

  it("a note saved since the last hover shows its new text", async () => {
    const { notifyWorkspaceChanged } = await import("../storage/workspaceEvents");
    await writeWorkspaceFile("Fresh.md", "# Old\n");
    await ensureIndex(true);
    const { container: a } = render((await renderPreview("Fresh"))!);
    expect(a.textContent).toContain("Old");
    cleanup();
    await writeWorkspaceFile("Fresh.md", "# New\n");
    notifyWorkspaceChanged({ kind: "content", paths: ["Fresh.md"] });
    const { container: b } = render((await renderPreview("Fresh"))!);
    expect(b.textContent).toContain("New");
  });
});
