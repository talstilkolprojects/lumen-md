/** T31 — background alt text for pasted images, including the data-URL fallback. */
import { describe, it, expect, vi } from "vitest";

vi.mock("../ai/vision", async (orig) => ({
  ...(await orig<object>()),
  imageText: vi.fn(async () => ({ alt: "Image with text: Hello", title: "Hello", source: "ocr" })),
}));

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { fillPastedImageText } from "../editor/pastedImageText";

describe("fillPastedImageText", () => {
  it("replaces the file-name alt of a data-URL image (OPFS unavailable) too", async () => {
    const url = "data:image/png;base64,AAAA";
    const view = new EditorView({ state: EditorState.create({ doc: `x\n![shot](${url})\n` }) });
    await fillPastedImageText(view, [{ file: new File(["x"], "shot.png", { type: "image/png" }), url, alt: "shot" }], "en");
    expect(view.state.doc.toString()).toBe(`x\n![Image with text: Hello](${url} "Hello")\n`);
    view.destroy();
  });

  it("leaves an image the user already edited alone", async () => {
    const view = new EditorView({ state: EditorState.create({ doc: "![mine](assets/a.png)" }) });
    await fillPastedImageText(view, [{ file: new File(["x"], "a.png"), url: "assets/a.png", alt: "a" }], "en");
    expect(view.state.doc.toString()).toBe("![mine](assets/a.png)");
    view.destroy();
  });
});
