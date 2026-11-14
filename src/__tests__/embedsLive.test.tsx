/**
 * Plan 4.7 — live embeds: the preview re-renders an `![[embed]]` when the
 * embedded note is saved, and a missing target once it is created.
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeOpfs } from "./helpers/fakeOpfs";
import { writeWorkspaceFile } from "../storage/workspace";
import { notifyWorkspaceChanged } from "../storage/workspaceEvents";
import { __resetWorkspaceIndex } from "../storage/workspaceIndex";
import { loadEmbedContext, embedNotice } from "../renderer/embedContext";
import { createEmbedContext } from "../renderer/embeds";
import { renderMarkdownFast } from "../renderer/pipeline";

vi.mock("../lib/idle", () => ({ scheduleIdle: (cb: () => void) => (cb(), () => {}) }));

import { Preview } from "../renderer/Preview";

beforeEach(() => {
  installFakeOpfs();
  __resetWorkspaceIndex();
});
afterEach(cleanup);

const bodyText = (c: HTMLElement) => c.querySelector(".lumen-embed-body")?.textContent ?? null;

describe("live embeds", () => {
  it("shows the embedded note's new text after it is saved", async () => {
    await writeWorkspaceFile("Source.md", "first version");
    const { container } = render(<Preview markdownText={"Host\n\n![[Source]]"} docKey="ws:Host.md" />);
    await waitFor(() => expect(bodyText(container)).toBe("first version"), { timeout: 4000 });

    await writeWorkspaceFile("Source.md", "second version");
    act(() => notifyWorkspaceChanged({ kind: "content", paths: ["Source.md"] }));
    await waitFor(() => expect(bodyText(container)).toBe("second version"), { timeout: 4000 });
  });

  it("a missing target appears once the note is created", async () => {
    const { container } = render(<Preview markdownText="![[Later]]" docKey="ws:Host.md" />);
    await waitFor(
      () => expect(container.querySelector<HTMLElement>(".lumen-embed-notice")?.dataset.embedStatus).toBe("notFound"),
      { timeout: 4000 },
    );

    await writeWorkspaceFile("Later.md", "here now");
    act(() => notifyWorkspaceChanged({ kind: "structure" }));
    await waitFor(() => expect(bodyText(container)).toBe("here now"), { timeout: 4000 });
  });

  it("lists the pasted assets that exist, so a deleted one is reported missing", async () => {
    await writeWorkspaceFile("lumen-asset-here.png", "png");
    const ctx = await loadEmbedContext("![[lumen-asset-here.png|40]] ![[lumen-asset-gone.png]]", "ws:Host.md");
    expect(ctx?.paths).toContain("lumen-asset-here.png");
    expect(ctx?.paths).not.toContain("lumen-asset-gone.png");
  });

  it("reads an embedded image again when its version changes", async () => {
    const realCreate = URL.createObjectURL;
    let n = 0;
    URL.createObjectURL = vi.fn(() => `blob:test/${++n}`);
    try {
      await writeWorkspaceFile("versioned.png", "v1");
      const tree = (modified: number) =>
        renderMarkdownFast("![[versioned.png]]", {
          embeds: createEmbedContext({ hostPath: "h.md", hostText: "", files: [{ path: "versioned.png", content: "", modified }], notice: embedNotice }),
        });
      const { container, rerender } = render(tree(1));
      await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:test/1"));
      rerender(tree(1));
      expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:test/1");
      await writeWorkspaceFile("versioned.png", "v2");
      rerender(tree(2));
      await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:test/2"));
    } finally {
      URL.createObjectURL = realCreate;
    }
  });
});
