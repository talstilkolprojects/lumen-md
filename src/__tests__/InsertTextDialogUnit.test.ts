import { describe, it, expect, vi } from "vitest";

vi.mock("../i18n", () => ({
  t: (k: string) => k,
}));
vi.mock("../data/smartDetect", () => ({
  smartDetect: vi.fn().mockReturnValue({ kind: "markdown", label: "📝 Markdown", rendered: "" }),
  renderAs: vi.fn().mockReturnValue(""),
  ALL_KINDS: [
    { kind: "markdown", label: "📝 Markdown" },
    { kind: "code", label: "💻 Code" },
  ],
}));

describe("openInsertTextDialog", () => {
  it("can be imported without errors", async () => {
    const mod = await import("../ui/InsertTextDialog");
    expect(typeof mod.openInsertTextDialog).toBe("function");
  });
});

