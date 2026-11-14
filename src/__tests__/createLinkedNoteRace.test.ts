import { describe, it, expect, beforeEach, vi } from "vitest";
import { installFakeOpfs, type FakeDir } from "./helpers/fakeOpfs";
import { readWorkspaceFile, writeWorkspaceFile } from "../storage/workspace";
import { createLinkedNote } from "../editor/wikiLinkData";

vi.mock("../ui/AiToast", () => ({ showAiToast: vi.fn() }));

let root: FakeDir;
beforeEach(() => {
  root = installFakeOpfs();
});

describe("#217 P1: creating a linked note has no check-then-write race", () => {
  it("a write that lands while the existence check runs is not truncated", async () => {
    // Another tab / sync / agent writes the note just as the check looks: the
    // check still answers "absent", and the competing write finishes first.
    const original = root.getFileHandle.bind(root);
    let competing: Promise<void> | null = null;
    root.getFileHandle = (async (name: string, opts: { create?: boolean } = {}) => {
      if (name === "Race.md" && !opts.create && !competing) {
        competing = writeWorkspaceFile("Race.md", "their text");
        await new Promise((r) => setTimeout(r, 20));
        throw new DOMException("Race.md not found", "NotFoundError");
      }
      return original(name, opts);
    }) as typeof root.getFileHandle;

    await createLinkedNote("Race.md");
    await competing;
    expect(await readWorkspaceFile("Race.md")).toBe("their text");
  });

  it("still creates a note that doesn't exist, and refuses one that does", async () => {
    expect(await createLinkedNote("Fresh.md")).toBe(true);
    expect(await readWorkspaceFile("Fresh.md")).toBe("# Fresh\n\n");
    expect(await createLinkedNote("Fresh.md")).toBe(false);
  });
});
