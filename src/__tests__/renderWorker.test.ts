/**
 * Plan 8.1 — the render worker (W10.E1, E2).
 *
 * The worker's own request handler (src/renderer/renderWorkerCore.ts, the
 * code render.worker.ts runs) answers through a port that passes every
 * message through structuredClone, as postMessage does; only the thread is
 * not real here (a real Worker needs the Vite build: e2e, owed on the Mac).
 *
 * - Every fixture renders the same through the worker as on the main thread.
 * - While the worker answers, nothing renders on the main thread.
 * - A newer request on a channel makes the older one stale.
 * - No worker, a worker that cannot start, one that crashes, one that
 *   reports an error: the main thread renders, and the result is the same.
 * - Shiki and KaTeX keep their output per block (E2).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown, renderStats, RenderSuperseded } from "../renderer/pipeline";
import { StaticRenderContext } from "../renderer/components";
import { nextVersion, setRenderPortFactory, type RenderPort } from "../renderer/renderClient";
import { createRenderHandler } from "../renderer/renderWorkerCore";
import type { RenderReply, RenderRequest } from "../renderer/renderProtocol";
import { createEmbedContext } from "../renderer/embeds";
import { embedNotice } from "../renderer/embedContext";
import { applyLocale, loadLocale } from "../i18n";
import { clearMathCache, katexStats } from "../renderer/math";
import { renderDocs } from "./fixtures/renderDocs";

const html = (el: ReactElement) => renderToStaticMarkup(createElement(StaticRenderContext.Provider, { value: true }, el));

/** The worker's handler behind a structured-clone boundary; `delay` holds each reply back. */
function inProcessWorker(opts: { delayMs?: number; log?: RenderRequest[] } = {}): RenderPort {
  const handler = createRenderHandler();
  const port: RenderPort = {
    onmessage: null,
    onerror: null,
    terminate() {},
    postMessage(msg) {
      const req = structuredClone(msg);
      opts.log?.push(req);
      void handler.handle(req).then(async (reply) => {
        if (!reply) return;
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        port.onmessage?.({ data: structuredClone(reply) } as MessageEvent<RenderReply>);
      });
    },
  };
  return port;
}

const docs = renderDocs();

afterEach(() => {
  setRenderPortFactory();
  applyLocale("en");
});

describe("the render worker gives what the main thread gives", () => {
  it("over every fixture document, light and dark — and nothing renders on the main thread meanwhile", async () => {
    expect(docs.length).toBeGreaterThanOrEqual(40);
    setRenderPortFactory(() => null); // no worker: the main thread
    const here: string[] = [];
    for (const d of docs) for (const dark of [false, true]) here.push(html(await renderMarkdown(d.markdown, () => dark)));
    setRenderPortFactory(() => inProcessWorker());
    const main = renderStats.mainThread;
    const worker = renderStats.worker;
    let k = 0;
    for (const d of docs) {
      for (const dark of [false, true]) {
        expect(html(await renderMarkdown(d.markdown, () => dark)), `${d.name}${dark ? " (dark)" : ""}`).toBe(here[k++]);
      }
    }
    expect(renderStats.mainThread - main).toBe(0);
    expect(renderStats.worker - worker).toBe(docs.length * 2);
  }, 600_000);

  it("callout titles come translated in the request: Hebrew in the worker as on the main thread", async () => {
    await loadLocale("he");
    applyLocale("he");
    const md = "> [!warning]\n> זהירות\n\n> [!tip]- Folded\n> body\n\n> [!custom-type]\n> x";
    setRenderPortFactory(() => null);
    const here = html(await renderMarkdown(md, () => false));
    setRenderPortFactory(() => inProcessWorker());
    const there = html(await renderMarkdown(md, () => false));
    expect(there).toBe(here);
    expect(here).not.toContain(">Warning<"); // the Hebrew title, not the English one
  });

  it("embeds render in the worker from the context's texts, and report the notes they used", async () => {
    const md = "# Host\n\n![[Other]]\n\n![[Missing]]\n\n![[Other#Part]]";
    const make = () =>
      createEmbedContext({
        hostPath: "host.md",
        hostText: md,
        files: [{ path: "host.md", content: md }, { path: "Other.md", content: "# Other\n\nText with $x$.\n\n## Part\n\nPart body." }, { path: "img.png" }],
        notice: embedNotice,
      });
    setRenderPortFactory(() => null);
    const a = make();
    const here = html(await renderMarkdown(md, () => false, { embeds: a }));
    setRenderPortFactory(() => inProcessWorker());
    const b = make();
    const main = renderStats.mainThread;
    const there = html(await renderMarkdown(md, () => false, { embeds: b }));
    expect(renderStats.mainThread).toBe(main);
    expect(there).toBe(here);
    expect([...b.used].sort()).toEqual([...a.used].sort());
    expect(b.used.has("Other.md")).toBe(true);
  });
});

describe("hover cards in the worker (W10.E4)", () => {
  it("the card is cut and rendered in the worker, the same as on the main thread, for the start, a heading and a block", async () => {
    const { renderHoverCard } = await import("../renderer/pipeline");
    const note = ["---", "title: x", "---", "# Plans", ...Array.from({ length: 30 }, (_, i) => `Line ${i + 1}.`), "", "## Later", "", "Later text. ^later", "", "## Later", "", "second later"].join("\n");
    const cases: Array<string | null> = [null, "Later", "later-1", "^later", "Nope"];
    setRenderPortFactory(() => null);
    const here: string[] = [];
    for (const f of cases) here.push(html(await renderHoverCard(note, f)));
    setRenderPortFactory(() => inProcessWorker());
    const main = renderStats.hoverMainThread;
    const worker = renderStats.hoverWorker;
    for (const [k, f] of cases.entries()) expect(html(await renderHoverCard(note, f)), String(f)).toBe(here[k]);
    expect(renderStats.hoverMainThread - main).toBe(0);
    expect(renderStats.hoverWorker - worker).toBe(cases.length);
    expect(here[3]).toContain("Later text.");
    expect(here[2]).toContain("second later");
  });
});

describe("the protocol", () => {
  it("a newer render on a channel makes the older one stale: the older rejects, the newer renders", async () => {
    const log: RenderRequest[] = [];
    setRenderPortFactory(() => inProcessWorker({ delayMs: 5, log }));
    const v1 = nextVersion("preview-a");
    const first = renderMarkdown("# One", () => false, { channel: { id: "preview-a", version: v1 } });
    const v2 = nextVersion("preview-a");
    const second = renderMarkdown("# Two", () => false, { channel: { id: "preview-a", version: v2 } });
    await expect(first).rejects.toBeInstanceOf(RenderSuperseded);
    expect(html(await second)).toContain("Two");
    // Each version told the worker first, so the stale request was skipped, not rendered.
    expect(log.filter((m) => m.type === "cancel").map((m) => (m as { version: number }).version)).toEqual([v1, v2]);
    // Another channel is not affected.
    const other = renderMarkdown("# Other", () => false, { channel: { id: "preview-b", version: nextVersion("preview-b") } });
    expect(html(await other)).toContain("Other");
  });

  it("without a Worker, the main thread renders", async () => {
    setRenderPortFactory(() => null);
    const main = renderStats.mainThread;
    expect(html(await renderMarkdown("# Here", () => false))).toContain("Here");
    expect(renderStats.mainThread - main).toBe(1);
  });

  it("a worker that cannot start, or that crashes mid-render, falls back to the main thread", async () => {
    setRenderPortFactory(() => {
      throw new Error("blocked by CSP");
    });
    expect(html(await renderMarkdown("# A", () => false))).toContain("A");
    let crash: RenderPort | null = null;
    setRenderPortFactory(() => {
      crash = { onmessage: null, onerror: null, terminate() {}, postMessage: () => queueMicrotask(() => crash!.onerror?.(new Error("worker died"))) };
      return crash;
    });
    const main = renderStats.mainThread;
    expect(html(await renderMarkdown("# B", () => false))).toContain("B");
    expect(renderStats.mainThread - main).toBe(1);
  });

  it("a worker that reports an error: the main thread renders the same note", async () => {
    setRenderPortFactory(() => {
      const port: RenderPort = {
        onmessage: null,
        onerror: null,
        terminate() {},
        postMessage: (m) => {
          if (m.type !== "cancel") queueMicrotask(() => port.onmessage?.({ data: { id: m.id, ok: false, error: "boom" } } as MessageEvent<RenderReply>));
        },
      };
      return port;
    });
    const main = renderStats.mainThread;
    expect(html(await renderMarkdown("**C**", () => false))).toContain("<strong>C</strong>");
    expect(renderStats.mainThread - main).toBe(1);
  });
});

describe("KaTeX once per formula (E2)", () => {
  beforeEach(() => clearMathCache());

  it("renders each distinct formula once; an edit elsewhere renders nothing again — and the output is rehype-katex's", async () => {
    setRenderPortFactory(() => inProcessWorker());
    const md = "Inline $a^2$ and $b_1$ and $a^2$ again.\n\n$$\n\\frac{1}{2}\n$$\n\n```math\nx+y\n```";
    const first = html(await renderMarkdown(md, () => false));
    // $a^2$ twice: one KaTeX run, one cache hit.
    expect(katexStats.rendered).toBe(4);
    expect(katexStats.cached).toBe(1);
    const second = html(await renderMarkdown(md + "\n\nA new paragraph.", () => false));
    expect(katexStats.rendered).toBe(4);
    expect(second).toContain("A new paragraph.");
    expect(first).toContain('class="katex"');
    expect(first).toContain('class="katex-display"');
  });

  it("per formula with a cache gives the tree rehype-katex gives over the whole document", async () => {
    const { unified } = await import("unified");
    const remarkParse = (await import("remark-parse")).default;
    const remarkMath = (await import("remark-math")).default;
    const remarkRehype = (await import("remark-rehype")).default;
    const rehypeKatex = (await import("../renderer/katexPlugin")).default;
    const { rehypeKatexCached } = await import("../renderer/math");
    const md = docs.find((d) => d.name === "syn-math")!.markdown + "\n\n- $x$ in a list, $x$ again\n\n> $$\n\\sum_i i\n$$\n\n```math\n\\sqrt{2}\n```\n\nBad: $\\frac{$";
    const tree = async (plugin: unknown) => {
      const p = unified().use(remarkParse).use(remarkMath).use(remarkRehype).use(plugin as never);
      return JSON.stringify(await p.run(p.parse(md)));
    };
    const whole = await tree(rehypeKatex);
    expect(whole).toContain("katex");
    expect(await tree(rehypeKatexCached(rehypeKatex))).toBe(whole);
    // And again from the cache.
    expect(await tree(rehypeKatexCached(rehypeKatex))).toBe(whole);
    expect(katexStats.cached).toBeGreaterThan(0);
  });
});

describe("the worker build", () => {
  it("the page's modules reach Shiki and KaTeX only through the core the worker runs; workers get the DOM-free HTML parser", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (f: string) => readFileSync(f, "utf8");
    for (const f of ["src/renderer/pipeline.ts", "src/renderer/Preview.tsx", "src/renderer/hoverPreview.tsx", "src/renderer/incrementalPreview.ts"]) {
      expect(read(f), f).not.toMatch(/from "\.\/(shiki|katexPlugin|math)"|import\("\.\/(shiki|katexPlugin|math)"\)|from "(shiki|katex|rehype-katex)"/);
    }
    expect(read("src/renderer/renderClient.ts")).toContain('new URL("./render.worker.ts", import.meta.url)');
    // rehype-katex parses KaTeX's HTML with hast-util-from-html-isomorphic, whose browser entry needs DOMParser.
    expect(read("vite.config.ts")).toMatch(/worker: \{ plugins: \(\) => \[[^\]]*htmlIsomorphicInWorkers/);
    expect(read("vite.config.ts")).toContain('"node_modules/hast-util-from-html-isomorphic/index.js"');
  });
});

