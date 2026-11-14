/**
 * The known limitations A1–A9 (plan 12.3): one test per item, named by its
 * id. Fixed items pin the fix; documented decisions (A4, A5, A7) pin the
 * documented behaviour. A8 (the research worker requires its token) is
 * tested next to the worker's other tests, in researchWorker.test.ts.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runVaultDoctor } from "../lint/vaultDoctor";
import { buildProject, circularImportMessage } from "../playground/files";
import PlaygroundBlock, { RUNNER_LOAD_MS } from "../plugins/PlaygroundBlock";
import { findTsBlocks, toUnits } from "../lsp/tsBlocks";
import { SAMPLE_WORDS, quoteCoverage, verifyCitations, type Citation } from "../research/citations";
import { planWrites, textHash, type BatchJob } from "../ai/batch";

// Keys instead of English text; the rest of the module (locale helpers the
// store and usage meter import) stays real.
vi.mock("../i18n", async (importOriginal) => ({ ...(await importOriginal<typeof import("../i18n")>()), t: (k: string) => k }));

/** Broken wiki links / missing headings the doctor reports for one note. */
const linkFindings = (text: string) =>
  runVaultDoctor([{ path: "note.md", text }])
    .filter((f) => f.kind === "broken-wiki-link" || f.kind === "missing-heading")
    .map((f) => f.detail);

describe("known limitations A1–A9", () => {
  afterEach(() => vi.useRealTimers());

  it("A1: a fence indented 4+ past a list item's content column is indented code, not a fence", () => {
    // CommonMark: the item's content starts at column 2, so `      ```` is
    // an indented code block inside the item — the ``` lines are code text
    // and so is everything after them at that indentation (`[[Inside]]`).
    expect(linkFindings("- item\n\n      ```\n      [[Gone]]\n      ```\n      [[Inside]]\n\n[[Outside]]\n")).toEqual(["Outside"]);
    // Up to 3 spaces past the content column it is still a fence of the item,
    // and an ordered item's wider column counts the same way.
    expect(linkFindings("- item\n\n     ```\n     [[Gone]]\n  ```\n\n[[Outside]]\n")).toEqual(["Outside"]);
    expect(linkFindings("1. item\n\n     ```\n     [[Gone]]\n   ```\n\n[[Outside]]\n")).toEqual(["Outside"]);
    // On the marker line, 5+ spaces after the marker are indented code too:
    // the next line at the content column is item text again.
    expect(linkFindings("-     ~~~\n     [[Target]]\n\n[[Outside]]\n")).toEqual(["Target", "Outside"]);
    expect(linkFindings("-     ```\n      [[Code]]\n\n[[Outside]]\n")).toEqual(["Outside"]);
    // A nested item closes when its parent's continuation dedents.
    expect(linkFindings("10. outer\n    - inner\n    outer\n\n        ```\n        [[Code]]\n        ```\n        [[After]]\n\n[[Outside]]\n")).toEqual(["Outside"]);
    // A fence dedented from a nested item to its parent belongs to the parent.
    expect(linkFindings("- outer\n  - inner\n\n   ```\n   [[Hidden]]\n  ```\n  [[After]]\n")).toEqual(["After"]);
    // A list inside a block quote ends with the quote.
    expect(linkFindings("> - item\n\n     ```\n     [[Code]]\n\n  ```\n  [[Fenced]]\n  ```\n\n[[Outside]]\n")).toEqual(["Outside"]);
    // The item's column holds across its continuation lines.
    expect(linkFindings("1. item\n    continued\n\n        ```\n        [[Gone]]\n        ```\n        [[After]]\n\n[[Outside]]\n")).toEqual(["Outside"]);
  });

  it("A2: a type 7 HTML tag after a line of only inline code can't interrupt that paragraph", () => {
    // The line above is paragraph text (`code`), so `<custom-tag>` is inline
    // HTML and `[[Gone]]` on the next line is a link.
    expect(linkFindings("`code`\n<custom-tag>\n[[Gone]]\n")).toEqual(["Gone"]);
    expect(linkFindings("text\n<custom-tag>\n[[Gone]]\n")).toEqual(["Gone"]);
    // After a blank line (or a fenced block) the tag does start an HTML block.
    expect(linkFindings("`code`\n\n<custom-tag>\n[[Hidden]]\n")).toEqual([]);
    expect(linkFindings("```\ncode\n```\n<custom-tag>\n[[Hidden]]\n")).toEqual([]);
  });

  it("A3: `&amp;` inside a double-backtick code span in a heading stays literal", () => {
    // ``a &amp; b`` renders the text `a &amp; b` (no decoding in code), so
    // its id is `a-amp-b`; `a & b` is not the heading.
    expect(linkFindings("## ``a &amp; b``\n\n[[#a-amp-b]] [[#a & b]]\n")).toEqual(["#a & b"]);
    expect(linkFindings("## `` `&amp;` x``\n\n[[#amp-x]] [[#& x]]\n")).toEqual(["#& x"]);
    // Outside code the reference is decoded, as before.
    expect(linkFindings("## A &amp; B\n\n[[#A & B]]\n")).toEqual([]);
  });

  it("A4: a circular module graph stops with a clear error that names the loop (decision)", () => {
    const project = buildProject("--- main.js ---\nimport './a.js';\n--- a.js ---\nimport './b.js';\n--- b.js ---\nimport './a.js';\n");
    expect(project.entry).toBe("main.js");
    const message = circularImportMessage(["main.js", "a.js", "b.js"], "a.js");
    expect(message).toMatch(/^Circular import: a\.js → b\.js → a\.js\./);
    expect(message).toContain("move the shared code into a separate file");
    // A self-import is a loop of one.
    expect(circularImportMessage(["main.js"], "main.js")).toMatch(/^Circular import: main\.js → main\.js\./);
  });

  it("A5: Netlify can't lift the runner's headers (decision); a runner that never loads is reported", () => {
    const root = process.cwd();
    // Cloudflare Pages detaches the app's frame / CSP headers for the runner…
    const headers = readFileSync(join(root, "public/_headers"), "utf8");
    const runner = headers.slice(headers.indexOf("/playground-runner.html"));
    expect(runner).toMatch(/^\/playground-runner\.html\n {2}! Content-Security-Policy\n {2}! X-Frame-Options\n/);
    // …Netlify's grammar has no such thing, and the limitation is documented there.
    const netlify = readFileSync(join(root, "netlify.toml"), "utf8");
    expect(netlify).toContain("Known limitation");
    expect(netlify).not.toMatch(/for\s*=\s*"\/playground-runner\.html"/);
    // In the app, a run whose runner page never says `ready` says why.
    vi.useFakeTimers();
    const { getByRole, queryByTestId, getByTestId } = render(createElement(PlaygroundBlock, { source: "console.log(1)" }));
    fireEvent.click(getByRole("button", { name: "block.playground.run" }));
    act(() => {
      vi.advanceTimersByTime(RUNNER_LOAD_MS - 1);
    });
    expect(queryByTestId("playground-stalled")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(getByTestId("playground-stalled").textContent).toBe("block.playground.runnerBlocked");
  });

  it("A6: a parameter named like an outer variable shadows it", () => {
    const doc = (...bodies: string[]) => bodies.map((b) => "```live-js shared\n" + b + "\n```").join("\n");
    const firstPart = (...bodies: string[]) => toUnits(findTsBlocks(doc(...bodies)))[1].code.split("\n;\n")[0];
    // `xs` inside the arrow is its parameter (the argument `holder`), not
    // the outer array literal: its `.map` may keep the callback, so the
    // callback sees the newest `value`.
    const first = firstPart(
      "const value = 1; const xs = [0]; const s = 'a'; const a = ((xs) => xs.map(() => value))(holder); const b = (function (s) { return s.replace('a', () => value); })(holder); const c = (({ xs }) => xs.map(() => value))(holder);",
      "const value = 'x';",
    );
    expect(first).toContain("((xs) => xs.map(() => value))(holder)");
    expect(first).toContain("return s.replace('a', () => value);");
    expect(first).toContain("(({ xs }) => xs.map(() => value))(holder)");
    // A parameter called `Array` / `Promise` isn't the built-in either.
    const builtins = firstPart("const value = 1; const r = ((Array, Promise) => [Array.from(() => value), new Promise(() => value)])(A, P);", "const value = 'x';");
    expect(builtins).toContain("Array.from(() => value)");
    expect(builtins).toContain("new Promise(() => value)");
    // …only inside that function: elsewhere they are still the built-ins.
    const elsewhere = firstPart("const value = 1; const saved = Array.from([0], () => value); const p = new Promise((r) => r(value)); const g = (Array, Promise) => [Array, Promise];", "const value = 'x';");
    expect(elsewhere).toContain("Array.from([0], () => value$prev)");
    expect(elsewhere).toContain("r(value$prev)");
    // A type annotation binds nothing: `Array` there is a type, the call is the built-in's.
    expect(firstPart("const value = 1; const r = ((xs: Array<number>) => Array.from(xs, () => value))([1]);", "const value = 'x';")).toContain("Array.from(xs, () => value$prev)");
    // Without the parameter, the outer literal still decides.
    expect(firstPart("const value = 1; const xs = [0]; const r = (() => xs.map(() => value))();", "const value = 'x';")).toContain("xs.map(() => value$prev)");
  });

  it("A7: a long quote is scored on samples, so a full sampled score is only 'approximate' (decision)", async () => {
    const page = Array.from({ length: 1200 }, (_, k) => `w${k}`);
    const quote = [...page];
    quote[220] = "invented"; // between two samples of a 1200-word quote
    expect(quote.length).toBeGreaterThan(SAMPLE_WORDS * 5);
    // The heuristic: the changed word falls between the samples.
    expect(quoteCoverage(quote.join(" "), page.join(" "))).toBe(1);
    const citation: Citation = { id: "1", url: "https://source.example/page", quote: quote.join(" "), line: 1 };
    const fetchPage = async () => ({ url: citation.url, finalUrl: citation.url, status: 200, text: page.join(" ") });
    const [check] = await verifyCitations([citation], fetchPage);
    expect(check.status).toBe("approximate");
    expect(check.detail).toContain("checked on samples");
    // Word for word it is still "supported".
    const [exact] = await verifyCitations([{ ...citation, quote: page.join(" ") }], fetchPage);
    expect(exact.status).toBe("supported");
  });

  it("A9: a retry finds the job's translation even after a lower-numbered copy was deleted", () => {
    const job: BatchJob = { id: "job1", provider: "openai", model: "m", op: "translate", lang: "French", createdAt: "", status: "ended", items: [{ customId: "n0", path: "x.md", hash: textHash("Hello") }] };
    const answers = new Map([["n0", "Bonjour"]]);
    const before = new Map([["x.md", "Hello"], ["x.french.md", "the user's own"]]);
    const [w] = planWrites(job, answers, (p) => before.get(p) ?? null);
    expect(w.path).toBe("x.french-2.md");
    // The job wrote x.french-2.md, its state wasn't saved, and the user
    // deleted x.french.md meanwhile: the retry must not write a copy there.
    const after = new Map([["x.md", "Hello"], [w.path, w.content]]);
    const read = (p: string) => after.get(p) ?? null;
    expect(planWrites(job, answers, read, undefined, [], [...after.keys()])).toEqual([]);
    // Another job's translation is still written.
    expect(planWrites({ ...job, id: "job2" }, answers, read, undefined, [], [...after.keys()]).map((x) => x.path)).toEqual(["x.french.md"]);
  });
});
