/**
 * Plugin developer experience (plan W3.10): the test kit that ships in the
 * template follows the app's capability table, every example plugin works
 * through it, the dev server reports a save within a second, and developer
 * mode reloads the plugin on that event.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadPlugin, METHODS } from "../../packages/create-lumen-plugin/template/tools/testkit.mjs";
import { startDevServer } from "../../packages/create-lumen-plugin/template/tools/dev-server.mjs";
import { METHOD_CAPABILITY } from "../plugins/runtime/capabilities";
import { connectDevPlugin, isLoopbackUrl, type DevDeps } from "../plugins/runtime/devPlugin";
import { memoryUsed } from "../plugins/runtime/protocol";
import type { PluginManifest } from "../plugins/runtime/manifest";
import type { PluginInstance } from "../plugins/runtime/pluginHost";

const EXAMPLES = resolve(__dirname, "../../public/plugins/examples");
const ex = (name: string) => join(EXAMPLES, name);

describe("test kit", () => {
  it("has exactly the app's method table", () => {
    expect(METHODS).toEqual(METHOD_CAPABILITY);
  });

  it("lists every example in the registry", () => {
    const index = JSON.parse(readFileSync(join(EXAMPLES, "index.json"), "utf8")) as { plugins: { versions: { path: string }[] }[] };
    expect(index.plugins.map((p) => p.versions[0].path).sort()).toEqual([
      "bidi-cleaner", "calendar", "callout", "daily-quote", "flashcards", "hebrew-date", "kanban", "linter", "natural-dates",
      "note-refactor", "sort-lines", "table-format", "tags", "tasks-overview", "templates", "text-format", "toc", "word-stats",
    ]);
  });
});

describe("example plugins through the test kit", () => {
  it("word-stats counts Hebrew and English and remembers the speed", async () => {
    const p = await loadPlugin({ dir: ex("word-stats"), document: { text: "שלום עולם hello world hello", fileName: "a.md" } });
    await p.run("show");
    expect(p.panel.open).toBe(true);
    expect(JSON.stringify(p.panel.tree)).toContain("Words: 5");
    await p.emit("ui:panel", { id: "wpm", kind: "change", value: "300" });
    expect(p.settings.wpm).toBe(300);
  });

  it("callout renders a block and stores a tick", async () => {
    const p = await loadPlugin({ dir: ex("callout") });
    const tree = await p.render("callout", "Plan\n- [ ] one\nSee [[Note]]");
    expect(tree.type).toBe("box");
    expect(JSON.stringify(tree)).toContain('"noteLink"');
    const box = (tree.children as { type: string; children?: { id: string }[] }[]).find((c) => c.type === "box");
    await p.emit("ui:block", { id: box!.children![0].id, kind: "change", value: true });
    expect([...p.storage.values()]).toEqual([{ 0: true }]);
  });

  it("daily-quote fetches only from the granted origin", async () => {
    const urls: string[] = [];
    const p = await loadPlugin({
      dir: ex("daily-quote"),
      fetch: (url: string) => (urls.push(url), { status: 200, headers: {}, body: JSON.stringify({ quote: "Q", author: "A", text: "Q", q: "Q", a: "A" }) }),
    });
    const [id] = [...p.commands.keys()];
    await p.run(id);
    expect(urls.length).toBe(1);
    expect(new URL(urls[0]).origin).toBe("https://example.com");
    const denied = await loadPlugin({ dir: ex("daily-quote"), grants: ["commands", "document:write", "notifications"] });
    await denied.run(id).catch(() => undefined);
    expect([...denied.denied.keys()].some((k) => k.startsWith("network:"))).toBe(true);
  });

  it("toc inserts nested [[#…]] links, skipping code and front matter", async () => {
    const text = "---\ntitle: x\n---\n# מבוא\n```\n# not a heading\n```\n## Part **two**\n#### too deep\n";
    const p = await loadPlugin({ dir: ex("toc"), document: { text } });
    p.select(0);
    await p.run("insert");
    expect(p.document.text.startsWith("- [[#מבוא|מבוא]]\n  - [[#Part two|Part two]]\n---")).toBe(true);
  });

  it("hebrew-date matches ICU for every day of 1950–2050 (and Hebcal where ICU is off)", async () => {
    const p = await loadPlugin({ dir: ex("hebrew-date") });
    const icu = new Intl.DateTimeFormat("he-u-ca-hebrew", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
    const g = (n: number) => {
      const ones = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"], tens = ["", "י", "כ", "ל", "מ", "נ", "ס", "ע", "פ", "צ"], hundreds = ["", "ק", "ר", "ש", "ת", "תק", "תר", "תש", "תת", "תתק"];
      const r = n % 100;
      const s = hundreds[Math.floor(n / 100)] + (r === 15 ? "טו" : r === 16 ? "טז" : tens[Math.floor(r / 10)] + ones[r % 10]);
      return s.length === 1 ? `${s}׳` : `${s.slice(0, -1)}״${s.slice(-1)}`;
    };
    // The block renderer converts many dates in one call: one block per year.
    let mismatches = 0;
    let checked = 0;
    for (let y = 1950; y <= 2050; y++) {
      const dates: string[] = [];
      for (let t = Date.UTC(y, 0, 1); t < Date.UTC(y + 1, 0, 1); t += 86400000) dates.push(new Date(t).toISOString().slice(0, 10));
      const tree = await p.render("hebrew-date", dates.join("\n"));
      const items = (tree.items as { text: string }[][]).map((row) => row[0].text);
      items.forEach((line, i) => {
        const [day, month, year] = (() => {
          const parts = icu.formatToParts(new Date(`${dates[i]}T00:00:00Z`));
          const v = (k: string) => parts.find((x) => x.type === k)!.value;
          return [Number(v("day")), v("month").replace(/^ב/, ""), Number(v("year"))];
        })();
        // ICU (Node 22) makes 5806 a 385-day year and shortens 5807 to make up
        // for it, so it is a day off from 2045-11-10 to 2046-11-29. Hebcal and
        // the rules of the calendar give 384 (1 Tishri 5807 = 2046-10-01,
        // pinned below).
        if (dates[i] >= "2045-11-10" && dates[i] <= "2046-11-29") return;
        checked++;
        if (line !== `${dates[i]} — ${g(day)} ב${month} ${g(year % 1000)}`) mismatches++;
      });
    }
    expect(checked).toBeGreaterThan(36500);
    expect(mismatches).toBe(0);
    const pinned = await p.render("hebrew-date", "2045-09-12\n2045-11-10\n2046-09-30\n2046-10-01");
    expect((pinned.items as { text: string }[][]).map((r) => r[0].text.split(" — ")[1])).toEqual(["א׳ בתשרי תת״ו", "א׳ בכסלו תת״ו", "כ״ט באלול תת״ו", "א׳ בתשרי תת״ז"]);
    p.select(0);
    await p.run("insert", { date: "2026-11-10" });
    expect(p.document.text).toBe("ל׳ בחשוון תשפ״ז");
  });

  it("tasks-overview walks the vault read-only and lists open tasks per note", async () => {
    const vault = { "a.md": "- [ ] buy milk\n- [x] done\n```\n- [ ] in code\n```", "dir/b.md": "1. [ ] לכתוב פרק", ".hidden/c.md": "- [ ] hidden", "img.png": "x" };
    const p = await loadPlugin({ dir: ex("tasks-overview"), vault });
    await p.run("show");
    const s = JSON.stringify(p.panel.tree);
    expect(s).toContain("2 open · 1 done");
    expect(s).toContain('"target":"dir/b"');
    expect(s).not.toContain("in code");
    expect(s).not.toContain("hidden");
    expect(p.calls.every((c) => c.method !== "vault.write")).toBe(true);
  });

  it("bidi-cleaner removes marks from the selection, or the whole note, but not from code", async () => {
    const rlm = String.fromCharCode(0x200f), lri = String.fromCharCode(0x2066), pdi = String.fromCharCode(0x2069), zwj = String.fromCharCode(0x200d);
    const text = `שלום${rlm} ${lri}world${pdi}\n\`a${rlm}\`\n\`\`\`\n${rlm}\n\`\`\`\n👩${zwj}💻`;
    const p = await loadPlugin({ dir: ex("bidi-cleaner"), document: { text } });
    await p.run("clean");
    expect(p.document.text).toBe(`שלום world\n\`a${rlm}\`\n\`\`\`\n${rlm}\n\`\`\`\n👩${zwj}💻`);
    expect(p.notifications.at(-1)).toEqual({ text: "Removed 3 invisible marks.", kind: "success" });
    const q = await loadPlugin({ dir: ex("bidi-cleaner"), document: { text: `a${rlm}b c${rlm}d` } });
    q.select(0, 3);
    await q.run("clean");
    expect(q.document.text).toBe(`ab c${rlm}d`);
  });

  it("text-format (port of obsidian-text-format) works on the selection", async () => {
    const cases: [string, string, string][] = [
      ["title-case", "the lord of the rings: a tale", "The Lord of the Rings: A Tale"],
      ["slugify", "Hello שלום World!", "hello-שלום-world"],
      ["camel-case", "hello big world", "helloBigWorld"],
      ["pascal-case", "hello big world", "HelloBigWorld"],
      ["snake-case", "Hello Big World", "hello_big_world"],
      ["capitalize-sentences", "one. two! three", "One. Two! Three"],
      ["lowercase", "İSTANBUL", "istanbul"],
      ["spaces", "a  b   c  ", "a b c"],
    ];
    for (const [id, input, out] of cases) {
      const p = await loadPlugin({ dir: ex("text-format"), document: { text: input } });
      p.select(0, input.length);
      await p.run(id);
      expect(p.document.text, id).toBe(out);
    }
    expect(readFileSync(join(ex("text-format"), "LICENSE"), "utf8")).toContain("Copyright (c) 2021 Benature Wong");
  });

  it("the template passes the safety scan (only the unsigned note)", async () => {
    const { scanPluginVersion } = await import("../plugins/runtime/scan");
    const dir = resolve(__dirname, "../../packages/create-lumen-plugin/template");
    const manifest = JSON.parse(readFileSync(join(dir, "lumen-plugin.json"), "utf8").replace(/__PLUGIN_NAME__/g, "my-plugin").replace(/__PLUGIN_TITLE__/g, "My plugin"));
    const r = await scanPluginVersion({ manifest, main: readFileSync(join(dir, "main.js"), "utf8") });
    expect(r.passed).toBe(true);
    expect(r.findings.map((f) => f.rule)).toEqual(["unsigned"]);
  });

  it("the template's own plugin passes through the kit", async () => {
    const p = await loadPlugin({ dir: resolve(__dirname, "../../packages/create-lumen-plugin/template"), document: { text: "a b" } });
    await p.run("show");
    expect(p.panel.tree?.type).toBe("box");
  });
});

describe("dev server", () => {
  it("serves the folder and sends a change event within a second of a save", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lumen-plugin-dev-"));
    writeFileSync(join(dir, "lumen-plugin.json"), '{"schema":1}');
    writeFileSync(join(dir, "main.js"), "// v1");
    const server = await startDevServer({ dir, port: 0, log: () => {} });
    const ac = new AbortController();
    try {
      expect(await (await fetch(`${server.url}/main.js`)).text()).toBe("// v1");
      expect((await fetch(`${server.url}/../etc/passwd`)).status).toBe(404);
      const res = await fetch(`${server.url}/events`, { signal: ac.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (!buf.includes("event: hello")) buf += dec.decode((await reader.read()).value);
      const t0 = performance.now();
      writeFileSync(join(dir, "main.js"), "// v2");
      while (!buf.includes("event: change")) buf += dec.decode((await reader.read()).value);
      expect(performance.now() - t0).toBeLessThan(1000);
      expect(buf).toContain('"main.js"');
    } finally {
      ac.abort();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("developer mode", () => {
  it("accepts only this computer", () => {
    expect(isLoopbackUrl("http://127.0.0.1:5199")).toBe(true);
    expect(isLoopbackUrl("http://localhost:3000")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:5199")).toBe(true);
    expect(isLoopbackUrl("http://192.168.1.2:5199")).toBe(false);
    expect(isLoopbackUrl("http://127.0.0.1.evil.example")).toBe(false);
    expect(isLoopbackUrl("http://user:pw@localhost")).toBe(false);
    expect(isLoopbackUrl("file:///etc")).toBe(false);
  });

  it("loads, reloads on a change event with the manifest's grants, and stops on close", async () => {
    let version = "1.0.0";
    const manifest = () => JSON.stringify({ schema: 1, id: "local.dev", name: "Dev", version, description: "", author: "", license: "MIT", main: "./main.js", capabilities: [{ id: "panel", reason: "r" }] });
    const files: Record<string, () => string> = { "lumen-plugin.json": manifest, "main.js": () => `// ${version}` };
    const fetched: string[] = [];
    const started: { code: string; grants: string[] }[] = [];
    const stopped: string[] = [];
    let source: { fire: () => void; closed: boolean } | null = null;
    let clock = 0;
    class FakeES {
      onerror: ((e: unknown) => void) | null = null;
      closed = false;
      listeners = new Map<string, (e: { data?: string }) => void>();
      constructor() {
        const es = this;
        source = {
          fire: () => es.listeners.get("change")?.({ data: "{}" }),
          get closed() {
            return es.closed;
          },
        };
      }
      addEventListener(t: string, fn: (e: { data?: string }) => void) {
        this.listeners.set(t, fn);
      }
      close() {
        this.closed = true;
      }
    }
    const deps: Partial<DevDeps> = {
      fetch: async (url) => {
        fetched.push(url);
        const f = files[url.split("/").pop()!];
        return f ? { ok: true, status: 200, text: async () => f() } : { ok: false, status: 404, text: async () => "" };
      },
      EventSource: FakeES,
      start: async ({ code, grants }) => (started.push({ code, grants: [...grants] }), { id: "local.dev" } as unknown as PluginInstance),
      stop: async (id) => void stopped.push(id),
      scan: async () => ({ passed: true, findings: [] }) as never,
      parse: (j) => JSON.parse(j) as PluginManifest,
      now: () => (clock += 5),
    };
    const seen: string[] = [];
    const c = await connectDevPlugin("http://127.0.0.1:5199/", deps);
    c.onChange((s) => seen.push(`${s.state}:${s.manifest?.version}`));
    expect(c.status.state).toBe("running");
    expect(started).toEqual([{ code: "// 1.0.0", grants: ["panel"] }]);
    expect(fetched).toEqual(["http://127.0.0.1:5199/lumen-plugin.json", "http://127.0.0.1:5199/main.js"]);
    version = "1.0.1";
    source!.fire();
    await c.reload(); // waits for the reload the event started (and runs one more)
    expect(started.map((s) => s.code)).toContain("// 1.0.1");
    expect(c.status.reloads).toBeGreaterThanOrEqual(2);
    expect(c.status.lastReloadMs).toBeGreaterThan(0);
    expect(seen).toContain("running:1.0.1");
    files["main.js"] = () => {
      throw new Error("syntax");
    };
    await c.reload();
    expect(c.status.state).toBe("error");
    expect(c.status.error).toBe("syntax");
    await c.close();
    expect(source!.closed).toBe(true);
    expect(stopped).toEqual(["local.dev"]);
    await expect(connectDevPlugin("http://10.0.0.1:5199", deps)).rejects.toThrow(/this computer/);
  });
});

describe("sandbox stats", () => {
  it("reads QuickJS's memory-used line", () => {
    const dump = "QuickJS memory usage -- version, 64-bit, malloc limit: 33554432\n\n  malloc_usable_size: 8\n  memory allocated        1210     98304  (81.2 per block)\n  memory used              947     48798  (51.5 per block)\n";
    expect(memoryUsed(dump)).toBe(48798);
    expect(memoryUsed("nothing")).toBeNull();
  });
});
