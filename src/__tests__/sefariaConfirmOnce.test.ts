/**
 * Sefaria's lookup asks once, even when requests start before the answer
 * (review 25, RR25-1: the same pattern RR20-2 fixed in the open-sources gate).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../sources/sefaria/store", async () => {
  const actual = await vi.importActual<typeof import("../sources/sefaria/store")>("../sources/sefaria/store");
  return {
    ...actual,
    // Two requests in parallel, as a lookup that fetches the text and its index at once would make.
    lookupPassage: async (_ref: unknown, opts: { fetch: typeof fetch }) => {
      await Promise.all([opts.fetch("https://www.sefaria.org/api/v3/texts/A"), opts.fetch("https://www.sefaria.org/api/v3/texts/B")]);
      return { passage: null, saved: false };
    },
  };
});
vi.mock("../ai/privacyLedger", () => ({
  ledgerFetch: () => async () => new Response("{}", { status: 200 }),
}));

describe("Sefaria lookup (review 25, RR25-1)", () => {
  it("two requests before the answer share one question; a no sends neither", async () => {
    const { lookup } = await import("../sources/sefaria/app");
    let answer!: (v: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>((r) => (answer = r)));
    const ref = { book: "Genesis", chapter: 1 } as unknown as Parameters<typeof lookup>[0];
    const pending = lookup(ref, confirm);
    await new Promise((r) => setTimeout(r, 10));
    expect(confirm).toHaveBeenCalledTimes(1);
    answer(true);
    await pending;
    expect(confirm).toHaveBeenCalledTimes(1);

    const no = vi.fn(async () => false);
    expect(await lookup(ref, no)).toBeNull();
    expect(no).toHaveBeenCalledTimes(1);
  });
});
