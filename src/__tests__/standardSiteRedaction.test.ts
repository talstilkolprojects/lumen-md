/**
 * Review 23 (RR23-587-1, RR23-587-2): a Standard.site record never carries
 * what the preview shades as redacted, also when a record builder is called
 * directly, and #473's door is found whenever it is in the tree.
 *
 * The 12 notes are review 23's (rr23/t/r587-redact.test.ts); `shaded` is what
 * its preview oracle (CriticMarkup swap, micromark with the preview's
 * extensions, footnotes in remark-rehype's order, Chromium's parser) shaded.
 * Asserted for both call paths: the app's (`publishReadyText`, then
 * `documentRecord`) and direct calls (`documentRecord`, `summaryOf`).
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { documentRecord, exportDoorFound, publishReadyText, summaryOf } from "../publish/standardSite";

const CASES: Array<[string, string, string[]]> = [
  ["B1 review 20's A1", ["---", "title: Interview", "---", "", "Met the source on Sunday.", "", "<redact>", "Source: Z1Z, deputy CFO", "</redact>", "", "Public part Z2Z.", "", "<!-- private: Z3Z -->", "%% Z4Z %%", "", "Private notes below:", "<redact>", "Z5Z everything after"].join("\n"), ["Z1Z", "Z5Z", "Z3Z", "Z4Z"]],
  ["B2 a redacted first paragraph", "<redact>\nZ6Z secret first paragraph\n</redact>\n\nPublic.", ["Z6Z"]],
  ["B3 nested passages", "a <redact>Z1Z <redact>Z2Z</redact> Z3Z</redact> b Z9Z", ["Z1Z", "Z2Z", "Z3Z"]],
  ["B4 case and attributes", "a <REDACT class=x>Z1Z</Redact > b <redact\tid=1>Z2Z</redact> Z9Z", ["Z1Z", "Z2Z"]],
  ["B5 a close inside a quoted attribute", '<redact>Z1Z <span title="</redact>"> Z2Z</span> still secret Z3Z</redact> after Z9Z', ["Z1Z", "Z2Z", "Z3Z"]],
  ["B6 a close inside a code span", "<redact>Z1Z `</redact>` Z2Z still secret</redact> after Z9Z", ["Z1Z", "Z2Z"]],
  ["B7 a close inside an HTML comment", "<redact>Z1Z <!-- </redact> --> Z2Z still secret</redact> after Z9Z", ["Z1Z", "Z2Z"]],
  ["B8 a close inside a list item", "<redact>\n\n- Z1Z </redact> Z2Z\n- Z3Z\n\n</redact>\n\nafter Z9Z", ["Z1Z", "Z2Z", "Z3Z"]],
  ["B9 CriticMarkup in a tag before the close", "Notes.\n\n<redact>\nSource: Z1Z <span title={>>check<<} </redact> Z2Z, 054\n\nMet at the cafe Z3Z.", ["Z1Z", "Z2Z", "Z3Z"]],
  ["B10 a footnote moved into an unclosed passage", "Dana told me[^1] Z9Z.\n\n[^1]: Z1Z Dana Levi, deputy CFO\n\n## Private\n<redact>\nZ2Z everything below", ["Z2Z", "Z1Z"]],
  ["B11 an unclosed passage", "Public Z9Z.\n\n<redact>\nZ1Z\n\nZ2Z\n\n# Z3Z", ["Z1Z", "Z2Z", "Z3Z"]],
  ["B12 an open inside code (fail closed)", "a `<redact>` Z1Z b", []],
];

const rec = (md: string) => JSON.stringify(documentRecord({ site: "at://did:plc:x/site.standard.publication/1", path: "n.md", markdown: md, publishedAt: new Date(0) }));
const tokens = (s: string) => new Set(s.match(/Z\d+Z/g) ?? []);

describe("Standard.site records fail closed (review 23)", () => {
  for (const [name, md, shaded] of CASES) {
    it(name, async () => {
      const app = tokens(rec(await publishReadyText(md)));
      const direct = tokens(rec(md) + JSON.stringify(summaryOf(md)));
      expect({ app: shaded.filter((t) => app.has(t)), direct: shaded.filter((t) => direct.has(t)) }).toEqual({ app: [], direct: [] });
    });
  }

  it("public text around a cleanly closed passage stays", () => {
    expect(rec("a <redact>Z1Z</redact> b Z9Z")).toContain("Z9Z");
    expect(rec("<redact>\nZ1Z\n</redact>\n\nPublic Z9Z.")).toContain("Z9Z");
  });

  it("RR23-587-2: when #473's files are in the tree, the build-time lookup finds them", () => {
    const src = resolve(__dirname, "..");
    const found = exportDoorFound();
    expect(found.async, "src/storage/exportReady.ts exists but import.meta.glob missed it").toBe(existsSync(join(src, "storage/exportReady.ts")));
    expect(found.sync, "src/lib/redaction.ts exists but import.meta.glob missed it").toBe(existsSync(join(src, "lib/redaction.ts")));
  });
});
