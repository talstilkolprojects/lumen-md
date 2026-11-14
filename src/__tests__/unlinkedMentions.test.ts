/**
 * Unlinked mentions (4.6) against the `unlinked` golden set's dev split
 * (plan 7.10, #240; CC0, copied from eval/golden/unlinked/dev/notes.json —
 * the test split stays in CI), plus the Link action.
 */
import { describe, expect, it } from "vitest";
import golden from "./fixtures/golden/unlinked-dev.json";
import { findUnlinkedMentions, linkMention, type Mention } from "../lib/unlinkedMentions";

interface Item {
  id: string;
  title: string;
  text: string;
  titles: string[];
  mentions: Array<Mention & { prefix?: string }>;
}

const key = (m: Pick<Mention, "start" | "end" | "target">) => `${m.start}:${m.end}:${m.target}`;

describe("findUnlinkedMentions — golden dev split", () => {
  const items = (golden as { items: Item[] }).items;

  it("has the dev items", () => expect(items.length).toBe(8));

  for (const it_ of items) {
    it(`${it_.id}: exactly the expected spans`, () => {
      const got = findUnlinkedMentions(it_.text, it_.titles, it_.title);
      expect(got.map(key)).toEqual(it_.mentions.map(key));
      for (const m of it_.mentions) {
        const g = got.find((x) => key(x) === key(m))!;
        expect(g.text).toBe(m.text);
        expect(g.prefix).toBe(m.prefix);
      }
    });
  }

  it("precision and recall over the dev split are 1", () => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const x of items) {
      const want = new Set(x.mentions.map(key));
      const got = new Set(findUnlinkedMentions(x.text, x.titles, x.title).map(key));
      for (const k of got) (want.has(k) ? tp++ : fp++);
      for (const k of want) if (!got.has(k)) fn++;
    }
    expect({ precision: tp / (tp + fp), recall: tp / (tp + fn) }).toEqual({ precision: 1, recall: 1 });
  });
});

describe("findUnlinkedMentions — more cases", () => {
  const titles = ["Tel Aviv", "Tel Aviv Port", "תל אביב", "API"];
  it("longest title first; the shorter one inside it is not a mention", () => {
    expect(findUnlinkedMentions("We met at Tel Aviv Port.", titles).map((m) => m.target)).toEqual(["Tel Aviv Port"]);
  });
  it("two-letter Hebrew prefixes, front matter, code blocks and HTML attributes", () => {
    const text = "---\ntitle: Tel Aviv\n---\nשלתל אביב וב\n```\nTel Aviv\n```\n<span title=\"API\">x</span> ובתל אביב\n";
    expect(findUnlinkedMentions(text, titles).map((m) => [m.text, m.prefix])).toEqual([
      ["תל אביב", "של"],
      ["תל אביב", "וב"],
    ]);
  });
});

describe("linkMention", () => {
  it("links the title, keeping a Hebrew prefix outside and a different case as the label", () => {
    const text = "נפגשנו מתל אביב. see the api design notes";
    const [heb] = findUnlinkedMentions(text, ["תל אביב"]);
    expect(linkMention(text, heb)).toBe("נפגשנו מ[[תל אביב]]. see the api design notes");
    const [api] = findUnlinkedMentions(text, ["API Design"]);
    expect(linkMention(text, api)).toBe("נפגשנו מתל אביב. see the [[API Design|api design]] notes");
    expect(linkMention("Tel Aviv", { start: 0, end: 8, target: "Tel Aviv" }, "places/Tel Aviv")).toBe("[[places/Tel Aviv|Tel Aviv]]");
  });
});

describe("review fixes (PR #250)", () => {
  it("code in quotes, lists and indented blocks is not searched", () => {
    const text = "> ```\n> Tel Aviv\n> ```\n\n    Tel Aviv indented code\n\n- item\n\n  ```\n  Tel Aviv\n  ```\n\nTel Aviv in prose.\n";
    expect(findUnlinkedMentions(text, ["Tel Aviv"]).map((m) => text.slice(m.start, m.end + 9))).toEqual(["Tel Aviv in prose"]);
  });
  it("offsets are the text's own, even where lowercasing changes the length", () => {
    const text = "İ API here";
    const [m] = findUnlinkedMentions(text, ["API"]);
    expect([m.start, m.end, m.text]).toEqual([2, 5, "API"]);
    expect(linkMention(text, m)).toBe("İ [[API]] here");
  });
});
