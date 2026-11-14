/** T34 — without OPFS a clip isn't written anywhere: it must open as unsaved. */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../storage/workspace", async (orig) => ({
  ...(await orig<typeof import("../storage/workspace")>()),
  isOPFSAvailable: () => false,
}));

import { useAppStore } from "../store/useStore";
import { saveClip } from "../commands/useCommands";

describe("saveClip without OPFS", () => {
  beforeEach(() => {
    useAppStore.setState({ openTabs: [], doc: { name: "Welcome.md", content: "", dirty: false } });
  });

  it("opens the clip in its own dirty tab", async () => {
    await saveClip({ title: "Article", markdown: "# Article\n" });
    const s = useAppStore.getState();
    expect(s.doc).toMatchObject({ name: "Article.md", content: "# Article\n", dirty: true });
    expect(s.openTabs.find((t) => t.id === "Article.md")?.dirty).toBe(true);
    // A second clip with the same title never replaces the first.
    await saveClip({ title: "Article", markdown: "# Other\n" });
    expect(useAppStore.getState().openTabs.find((t) => t.id === "Article.md")?.content).toBe("# Article\n");
  });
});
