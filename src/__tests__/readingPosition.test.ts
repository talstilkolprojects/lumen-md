/**
 * W6.47 — the place in a PDF is kept in the vault and is the same on two
 * devices after sync: a phone at one zoom and a desktop at another open the
 * PDF at the same page and the same point of it.
 */
import { describe, expect, it } from "vitest";
import {
  loadPosition,
  mergePositions,
  parsePositions,
  positionAt,
  POSITIONS_FILE,
  savePosition,
  scrollTopFor,
  serializePositions,
  type PageBox,
  type PositionsIO,
} from "../pdf/readingPosition";

/** Page boxes of a PDF laid out at `scale` (A4 = 595 × 842 pt), with a gap between pages. */
const layout = (pages: number, scale: number, gap = 12): PageBox[] => Array.from({ length: pages }, (_, i) => ({ top: 8 + i * (842 * scale + gap), height: 842 * scale }));

/** A device's vault: one file system the sync copies between. */
const vault = (): PositionsIO & { files: Map<string, string> } => {
  const files = new Map<string, string>();
  return { files, read: async (p) => files.get(p) ?? null, write: async (p, t) => void files.set(p, t) };
};

describe("W6.47 reading position", () => {
  it("is the page and a fraction of it: the same on a phone and a desktop at different zooms", () => {
    const desktop = layout(40, 1.5);
    const phone = layout(40, 0.45);
    const at = positionAt(desktop, desktop[16].top + desktop[16].height * 0.37);
    expect(at).toEqual({ page: 17, offset: 0.37 });
    const top = scrollTopFor(phone, at);
    expect(positionAt(phone, top).page).toBe(17);
    expect(Math.abs(positionAt(phone, top).offset - 0.37)).toBeLessThan(0.005);
    expect(positionAt(desktop, 0)).toEqual({ page: 1, offset: 0 });
    expect(positionAt([], 500)).toEqual({ page: 1, offset: 0 });
    expect(scrollTopFor(phone, { page: 999, offset: 2 })).toBe(Math.round(phone[39].top + phone[39].height));
  });

  it("after sync, the second device opens the PDF where the first one left it", async () => {
    const a = vault();
    const b = vault();
    const desk = layout(12, 1.25);
    await savePosition(a, "papers/oz.pdf", positionAt(desk, desk[4].top + desk[4].height / 2), 1000);
    await savePosition(a, "papers/other.pdf", { page: 2, offset: 0 }, 1001);
    // The vault's sync copies the file to the phone.
    b.files.set(POSITIONS_FILE, a.files.get(POSITIONS_FILE)!);
    const pos = await loadPosition(b, "papers/oz.pdf");
    expect(pos).toEqual({ page: 5, offset: 0.5, updated: 1000 });
    const phone = layout(12, 0.5);
    const there = positionAt(phone, scrollTopFor(phone, pos!));
    expect(there.page).toBe(5);
    // Within a pixel of the same point (scroll positions are whole pixels).
    expect(Math.abs(there.offset - 0.5) * phone[4].height).toBeLessThanOrEqual(1);
    expect(await loadPosition(b, "papers/missing.pdf")).toBeNull();
  });

  it("two devices that read before syncing: each PDF keeps the newer place", () => {
    const a = parsePositions(serializePositions({ v: 1, docs: { "x.pdf": { page: 3, offset: 0.1, updated: 10 }, "y.pdf": { page: 9, offset: 0, updated: 50 } } }));
    const b = parsePositions(serializePositions({ v: 1, docs: { "x.pdf": { page: 7, offset: 0.2, updated: 20 }, "y.pdf": { page: 1, offset: 0, updated: 40 }, "z.pdf": { page: 2, offset: 0.9, updated: 5 } } }));
    expect(mergePositions(a, b).docs).toEqual({ "x.pdf": { page: 7, offset: 0.2, updated: 20 }, "y.pdf": { page: 9, offset: 0, updated: 50 }, "z.pdf": { page: 2, offset: 0.9, updated: 5 } });
    expect(mergePositions(b, a)).toEqual(mergePositions(a, b));
  });

  it("keeps every other PDF's place, skips a write that changes nothing, and reads a broken file as empty", async () => {
    const v = vault();
    await savePosition(v, "a.pdf", { page: 1, offset: 0.25 }, 1);
    await savePosition(v, "b.pdf", { page: 4, offset: 0.5 }, 2);
    const before = v.files.get(POSITIONS_FILE);
    await savePosition(v, "b.pdf", { page: 4, offset: 0.5001 }, 3);
    expect(v.files.get(POSITIONS_FILE)).toBe(before);
    expect(Object.keys(parsePositions(before!).docs)).toEqual(["a.pdf", "b.pdf"]);
    expect(parsePositions("{not json")).toEqual({ v: 1, docs: {} });
    expect(parsePositions('{"v":1,"docs":{"a.pdf":{"page":0,"offset":0,"updated":1},"b.pdf":{"page":2,"offset":0.5,"updated":1}}}').docs).toEqual({ "b.pdf": { page: 2, offset: 0.5, updated: 1 } });
  });
});
