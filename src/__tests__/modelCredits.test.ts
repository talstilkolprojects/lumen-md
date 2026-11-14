/**
 * Plan 1.7 step 5 — the model credits: every model or data file that is
 * bundled with Lumen or that it can download / pull has a credits entry
 * with its name, licence, source, attribution and what the licence
 * requires; ivrit.ai and Dicta are credited, first.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import registry from "../../models/registry.json";
import { creditProblems, licenceFamily, modelCredits, SHIPPED_DELIVERY, type RegistryModel } from "../ai/modelCredits";

const models = (registry as { models: RegistryModel[] }).models;

describe("model credits", () => {
  it("every bundled or downloadable model that is not forbidden has a complete entry", () => {
    const shipped = models.filter((m) => m.class !== "forbidden" && SHIPPED_DELIVERY.has(m.delivery ?? ""));
    const credits = modelCredits();
    expect(shipped.length).toBeGreaterThan(30);
    expect(credits.map((c) => c.id).sort()).toEqual(shipped.map((m) => m.id).sort());
    const broken = credits.map((c) => [c.id, creditProblems(c)] as const).filter(([, p]) => p.length);
    expect(broken).toEqual([]);
  });

  it("forbidden models and entries that are never delivered are not credited", () => {
    const ids = new Set(modelCredits().map((c) => c.id));
    for (const m of models) if (m.class === "forbidden" || m.delivery === "none") expect(ids.has(m.id), m.id).toBe(false);
  });

  it("ivrit.ai and Dicta are credited, as Hebrew models, before everything else", () => {
    const credits = modelCredits();
    const ivrit = credits.find((c) => c.id === "ivrit-ai/zipformer2-66m-streaming-he")!;
    expect(ivrit).toMatchObject({ hebrew: true, family: "cc-by", licenceUrl: "https://creativecommons.org/licenses/by/4.0/" });
    expect(ivrit.attribution).toMatch(/ivrit\.ai.*CC BY 4\.0/);
    const dicta = credits.find((c) => /DictaLM/.test(c.id))!;
    expect(dicta.hebrew).toBe(true);
    expect(dicta.attribution).toMatch(/Dicta/);
    const firstOther = credits.findIndex((c) => !c.hebrew);
    expect(credits.slice(0, firstOther).every((c) => c.hebrew)).toBe(true);
    expect(credits.slice(firstOther).some((c) => c.hebrew)).toBe(false);
  });

  it("a missing attribution or an unknown licence is a problem, not a silent omission", () => {
    const [c] = modelCredits([{ id: "x/new-model", kind: "llm", license: "Some-Licence-1.0", class: "allowed", delivery: "download", source: "https://example.org/x" }]);
    expect(creditProblems(c)).toEqual(["no attribution text", 'no licence requirement known for "Some-Licence-1.0"']);
  });

  it("licence families", () => {
    expect(["CC-BY-4.0", "Apache-2.0", "MIT", "MPL-2.0", "Llama 3.2 Community License", "Meta Llama 3 Community License", "Gemma Terms of Use"].map(licenceFamily)).toEqual(["cc-by", "apache", "mit", "mpl", "llama", "llama", "gemma"]);
    expect(licenceFamily("CC-BY-SA-4.0")).toBe("cc-by-sa");
    // Non-commercial is not a family the app may ship: it is forbidden in the registry.
    expect(licenceFamily("CC-BY-NC-4.0")).toBeNull();
  });
  it("CC BY-SA: credited with its licence; bundled only when unmodified, anything modified or derived is a download the user starts", () => {
    const base = { id: "x/sa-data", kind: "other", license: "CC-BY-SA-4.0", class: "conditional", source: "https://example.org/x", attribution: "X by Y, licensed CC BY-SA 4.0." };
    const [dl] = modelCredits([{ ...base, delivery: "user-download", unmodified: false }]);
    expect(dl).toMatchObject({ family: "cc-by-sa", licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0/" });
    expect(creditProblems(dl)).toEqual([]);
    const [shippedAsIs] = modelCredits([{ ...base, delivery: "bundled", unmodified: true }]);
    expect(creditProblems(shippedAsIs)).toEqual([]);
    const reason = "CC-BY-SA-4.0 is bundled but not marked unmodified: modified or derived content may only reach the user as a download they start";
    expect(creditProblems(modelCredits([{ ...base, delivery: "bundled", unmodified: false }])[0])).toEqual([reason]);
    expect(creditProblems(modelCredits([{ ...base, delivery: "bundled" }])[0])).toEqual([reason]);
    const [unnamed] = modelCredits([{ ...base, delivery: "download", attribution: "X by Y." }]);
    expect(creditProblems(unnamed)).toEqual(["CC BY-SA attribution does not name the licence"]);
  });

  it("every CC BY-SA entry is conditional, and a bundled one is unmodified with a NOTICE (licence and link) next to it", () => {
    const sa = models.filter((x) => /^CC-BY-SA/.test(x.license)) as Array<RegistryModel & { notice?: string }>;
    expect(sa.length).toBeGreaterThan(0);
    for (const m of sa) {
      expect(m.class, m.id).toBe("conditional");
      if (m.delivery !== "bundled") continue;
      expect(m.unmodified, m.id).toBe(true);
      const notice = readFileSync(m.notice!, "utf8");
      expect(notice).toMatch(/CC BY-SA 4\.0/);
      expect(notice).toContain("https://creativecommons.org/licenses/by-sa/4.0/");
      expect(notice).toMatch(/unmodified/i);
      // The credits dialog shows the same attribution, with the licence linked.
      const credit = modelCredits().find((c) => c.id === m.id)!;
      expect(credit.attribution).toMatch(/CC BY-SA 4\.0/);
      expect(credit.licenceUrl).toBe("https://creativecommons.org/licenses/by-sa/4.0/");
    }
  });
});
