/** T29 — a citation jump waits for the opened note, not the previous one. */
import { describe, it, expect } from "vitest";
import { Text } from "@codemirror/state";
import { readyToReveal } from "../editor/revealLine";

const doc = (s: string) => Text.of(s.split("\n"));

describe("readyToReveal", () => {
  it("is not ready while the previous (longer) note is still shown", () => {
    const previous = doc("a\nb\nc\nd\ne\nf");
    expect(readyToReveal(previous, 3, "x\ny\nz\n")).toBe(false);
    expect(readyToReveal(doc("x\ny\nz\n"), 3, "x\ny\nz\n")).toBe(true);
  });

  it("tolerates CRLF notes and falls back to the line count without content", () => {
    expect(readyToReveal(doc("x\ny\nz"), 2, "x\r\ny\r\nz")).toBe(true);
    expect(readyToReveal(doc("a\nb"), 2)).toBe(true);
    expect(readyToReveal(doc("a"), 2)).toBe(false);
  });
});
