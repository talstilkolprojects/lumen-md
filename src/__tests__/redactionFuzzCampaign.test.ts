/**
 * The nightly redaction fuzz's own logic (plan W8.8), with a fake oracle: the
 * seed of a night, the generators' determinism, minimising, and how a leak
 * becomes a regression case. The real oracle runs in the fuzz and in
 * redactionFuzzRegressions.test.ts.
 */
import { describe, expect, it } from "vitest";
import { mergeRegressions, minimise, nightDate, regressionId, runCampaign, toRegression, type Oracle } from "../../tests/fuzz/redaction/campaign";
import { GENERATORS, generatorSeed, seedForDate } from "../../tests/fuzz/redaction/generators";
import { TOKEN, tokensIn } from "../../tests/fuzz/redaction/tokens";

/** Leaks a token that follows a `<redact>` mark and is also on a line with `LEAK`. */
const fake: Oracle = {
  check(md) {
    const leaked = /<redact>/i.test(md) && md.includes("LEAK") ? ["LEAK"] : [];
    return { leaked, shaded: (md.match(/<redact/gi) ?? []).length };
  },
};

describe("redaction fuzz campaign (W8.8)", () => {
  it("a night's seed is its UTC date, and each generator gets its own stream", () => {
    expect(seedForDate(new Date("2026-11-14T23:30:00Z"))).toBe(20261114);
    expect(seedForDate(new Date("2027-01-02T00:00:00Z"))).toBe(20270102);
    expect(nightDate(20261114)).toBe("2026-11-14");
    const seeds = GENERATORS.map((_, i) => generatorSeed(20261114, i));
    expect(new Set(seeds).size).toBe(GENERATORS.length);
    expect(generatorSeed(20261115, 0)).not.toBe(seeds[0]);
  });

  it("the same seed gives the same notes; another seed, other notes; every note carries tokens", () => {
    for (const g of GENERATORS) {
      const a = g.stream(7);
      const b = g.stream(7);
      const c = g.stream(8);
      const xs = Array.from({ length: 30 }, a);
      expect(Array.from({ length: 30 }, b), g.id).toEqual(xs);
      expect(Array.from({ length: 30 }, c), g.id).not.toEqual(xs);
      expect(xs.filter((x) => tokensIn(x).size > 0).length, g.id).toBeGreaterThan(24);
      expect(xs.filter((x) => /<\/?redact/i.test(x)).length, g.id).toBeGreaterThan(20);
    }
  });

  it("the generators are the reviews' own: review 6's first note for seed 6 is unchanged", () => {
    const blocks = GENERATORS.find((g) => g.id === "blocks");
    const first = blocks?.stream(6)();
    expect(first).toBeTypeOf("string");
    // Its tokens are review 6's (`Q0000Z`, counted from 0 across the stream).
    expect([...(first ?? "").matchAll(TOKEN)][0]?.[0]).toBe("Q0000Z");
  });

  it("minimise keeps only what the leak needs", () => {
    const md = "intro line\n<redact>\nfiller one two\nsecret LEAK here\n\nmore filler";
    const min = minimise(md, (s) => fake.check(s).leaked.length > 0);
    expect(fake.check(min).leaked).toEqual(["LEAK"]);
    expect(min).toBe("<redact>\nLEAK");
  });

  it("a campaign counts every case, minimises leaks and reports what threw", () => {
    let calls = 0;
    const oracle: Oracle = {
      check(md) {
        calls++;
        if (calls === 3) throw new Error("boom");
        return fake.check(md.replace(/TK1Q/, "LEAK"));
      },
    };
    const res = runCampaign({ night: 20261114, n: 40, oracle, generators: GENERATORS.filter((g) => g.id === "tags") });
    expect(res.cases).toBe(40);
    expect(res.threw.length).toBe(1);
    expect(res.found.length).toBeGreaterThan(0);
    for (const f of res.found.slice(0, 5)) expect(f.min.length).toBeLessThanOrEqual(f.md.length);
    expect(res.perGenerator.tags.leaking).toBe(res.found.length);
  });

  it("a leak becomes a case named by its note, added once, in a stable order", () => {
    const found = { generator: "containers" as const, seed: 1, index: 2, md: "x", min: "<redact>\nLEAK", leaked: ["LEAK"] };
    const r = toRegression(found, 20261114);
    expect(r).toEqual({ id: regressionId("<redact>\nLEAK"), found: "2026-11-14", generator: "containers", seed: 1, index: 2, md: "<redact>\nLEAK", leaked: ["LEAK"] });
    expect(r.id).toMatch(/^rdx-[0-9a-f]{8}$/);
    const other = { ...r, id: regressionId("b"), md: "b" };
    const once = mergeRegressions({ about: "a", cases: [] }, [r, other, r]);
    expect(once.added.length).toBe(2);
    const twice = mergeRegressions(once.file, [other, r]);
    expect(twice.added).toEqual([]);
    expect(twice.file.cases.map((c) => c.id)).toEqual([...once.file.cases.map((c) => c.id)].sort());
  });
});
