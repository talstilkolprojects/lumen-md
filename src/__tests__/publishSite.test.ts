/**
 * 4.18 — publish to your own static site: a 50-note site with navigation,
 * search and right-to-left pages, then deployed to GitHub Pages (a fake
 * GitHub API here) or packed as a .zip.
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { buildSite, plainText, unlinkMissingPages, referencedFiles, hrefBetween, type SiteNote, type SiteFile } from "../publish/site";
import { deployToGitHubPages, parseRepo, pagesUrl, siteZip, DeployError } from "../publish/deploy";
import { unzip } from "../storage/zip";
import type { HtmlDocumentOptions } from "../storage/exportHtml";

/** A stand-in for renderHtmlDocument: the same document shape, a tiny Markdown subset. */
async function render(md: string, opts: HtmlDocumentOptions): Promise<string> {
  const rtl = /^[^A-Za-z]*[֐-׿]/.test(md.replace(/^---[\s\S]*?---/, "").replace(/[#\s*_-]/g, ""));
  const body = md
    .replace(/^---[\s\S]*?---\n?/, "")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">')
    .replace(/\[\[([^\]|]+)\]\]/g, (_m, t: string) => `<a class="wiki-link" data-wiki-target="${t}" href="#${t.toLowerCase().replace(/\s+/g, "-")}">${t}</a>`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^# (.*)$/gm, '<h1 id="$1">$1</h1>');
  return `<!doctype html>\n<html lang="${rtl ? "he" : "en"}" dir="${rtl ? "rtl" : "ltr"}" class="">\n<head>\n<title>${opts.title}</title>${opts.head ?? ""}\n</head>\n<body>\n${opts.before ?? ""}<main class="prose-lumen lumen-export">\n${body}\n</main>\n</body>\n</html>`;
}

/** Fifty notes: folders, Hebrew, links to each other, one link to a private note, an image. */
function vault(): SiteNote[] {
  const notes: SiteNote[] = [{ path: "index.md", content: "# Garden\n\nStart at [[Note 1]] or [the guide](guides/guide-1.md)." }];
  for (let i = 1; i <= 30; i++) notes.push({ path: `notes/Note ${i}.md`, content: `# Note ${i}\n\nLinks to [[Note ${(i % 30) + 1}]]. Topic ${i % 2 ? "apples" : "pears"}.` });
  for (let i = 1; i <= 10; i++) notes.push({ path: `guides/guide-${i}.md`, content: `# Guide ${i}\n\nSee [the next](guide-${(i % 10) + 1}.md) and [private](../private/secret.md).\n\n![diagram](img/d${i}.png)` });
  for (let i = 1; i <= 9; i++) notes.push({ path: `עברית/פתק ${i}.md`, content: `# פתק ${i}\n\nשלום עולם, מילה${i} ותפוחים.` });
  return notes;
}

const text = (files: SiteFile[], path: string): string => {
  const f = files.find((x) => x.path === path);
  if (!f) throw new Error(`no ${path}`);
  return typeof f.data === "string" ? f.data : new TextDecoder().decode(f.data);
};

describe("publish site (4.18)", () => {
  it("a 50-note site: a page per note, navigation on every page, search index, 404, no Jekyll", async () => {
    const notes = vault();
    expect(notes).toHaveLength(50);
    const read = async (p: string) => (p.startsWith("guides/img/") ? new Uint8Array([137, 80, 78, 71]) : null);
    const { files, pages, missing } = await buildSite(notes, { title: "My garden", lang: "en", render, readAsset: read });
    expect(pages).toHaveLength(50);
    for (const p of pages) expect(files.some((f) => f.path === p.output)).toBe(true);
    for (const f of ["style.css", "search.js", "search-index.json", "404.html", ".nojekyll"]) expect(files.some((x) => x.path === f), f).toBe(true);
    expect(files.filter((f) => f.path.endsWith(".png")).map((f) => f.path).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `guides/img/d${i + 1}.png`).sort());
    expect(missing).toEqual([]);

    // Every page lists all 50 in its navigation, the current one marked.
    const page = text(files, "notes/Note 3.html");
    expect(page.match(/<nav class="lumen-site-tree"[\s\S]*?<\/nav>/)![0].match(/<a /g)).toHaveLength(50);
    expect(page).toContain('href="Note%203.html" aria-current="page"');
    expect(page).toContain('href="../guides/guide-1.html"');
    expect(page).toContain('<link rel="stylesheet" href="../style.css" />');
    expect(page).toContain('<meta name="lumen-site-root" content="../" />');

    // Search: one entry per page, plain text.
    const index = JSON.parse(text(files, "search-index.json")) as { p: string; t: string; x: string }[];
    expect(index).toHaveLength(50);
    expect(index.find((e) => e.p === "notes/Note 1.html")).toEqual({ p: "notes/Note 1.html", t: "Note 1", x: "Note 1 Links to Note 2. Topic apples." });
  });

  it("links: wiki links and .md links reach the published page; links to unpicked notes lose the href", async () => {
    const { files } = await buildSite(vault(), { title: "G", lang: "en", render });
    const home = text(files, "index.html");
    expect(home).toContain('href="notes/Note%201.html"');
    expect(home).toContain('href="guides/guide-1.html"');
    const guide = text(files, "guides/guide-1.html");
    expect(guide).toContain('<a href="guide-2.html">the next</a>');
    expect(guide).not.toContain("secret");
    expect(guide).toContain('<span class="lumen-site-unpublished">private</span>');
    expect(files.some((f) => f.path.includes("private"))).toBe(false);
    // Picking fewer notes: the links to the rest are unlinked too.
    const few = await buildSite(vault().filter((n) => n.path === "index.md"), { title: "G", lang: "en", render });
    expect(text(few.files, "index.html")).not.toContain("guides/guide-1.html");
  });

  it("right-to-left: Hebrew pages keep their direction; a Hebrew site's chrome is right-to-left", async () => {
    const { files } = await buildSite(vault(), { title: "הגן", lang: "he", render });
    const he = text(files, "עברית/פתק 1.html");
    expect(he).toContain('<html lang="he" dir="rtl"');
    expect(he).toContain('<main dir="rtl" class="prose-lumen lumen-export">');
    expect(he).toContain('<header class="lumen-site-bar" dir="rtl" lang="he">');
    expect(he).toContain('placeholder="חיפוש"');
    const en = text(files, "notes/Note 1.html");
    expect(en).toContain('<main dir="ltr"');
    expect(en).toContain('<div class="lumen-site-layout" dir="rtl">');
  });

  it("without an index note, the home page lists every page", async () => {
    const { files } = await buildSite(vault().filter((n) => n.path !== "index.md"), { title: "Garden", lang: "en", render });
    const home = text(files, "index.html");
    expect(home).toContain("<h1");
    expect(home.match(/<main[\s\S]*<\/main>/)![0].match(/<a /g)).toHaveLength(49);
  });

  it("reports images it could not read and leaves them as links", async () => {
    const { missing, files } = await buildSite([{ path: "a.md", content: "![x](pics/missing.png)" }], { title: "S", lang: "en", render, readAsset: async () => null });
    expect(missing).toEqual(["pics/missing.png"]);
    expect(files.some((f) => f.path === "pics/missing.png")).toBe(false);
  });

  it("helpers", () => {
    expect(plainText("---\ntitle: x\n---\n# H\n\n**b** [l](http://x) [[N|alias]] `c` ```js\ncode\n```")).toBe("H b l alias c");
    expect(hrefBetween("a/b/c.html", "a/d.html")).toBe("../d.html");
    expect(hrefBetween("index.html", "x y/z.html")).toBe("x%20y/z.html");
    expect(referencedFiles('<img src="img/a%20b.png"><a href="doc.pdf">x</a><a href="p.html">y</a><img src="https://x/y.png">', "notes")).toEqual(["notes/img/a b.png", "notes/doc.pdf"]);
    expect(unlinkMissingPages('<a href="x.html#h">X</a><a href="https://e.com">E</a>', "index.html", new Set(["x.html"]))).toBe('<a href="x.html#h">X</a><a href="https://e.com">E</a>');
    expect(parseRepo("tal/garden")).toEqual({ owner: "tal", repo: "garden" });
    expect(parseRepo("https://github.com/tal/garden.git")).toEqual({ owner: "tal", repo: "garden" });
    expect(parseRepo("git@github.com:tal/garden")).toEqual({ owner: "tal", repo: "garden" });
    expect(parseRepo("not a repo")).toBeNull();
    expect(pagesUrl("Tal", "garden")).toBe("https://tal.github.io/garden/");
    expect(pagesUrl("tal", "Tal.github.io")).toBe("https://tal.github.io/");
  });
});

/** A fake api.github.com: records each call, answers like GitHub. */
function fakeGitHub(opts: { branchExists?: boolean; pagesOn?: boolean; status?: Record<string, number> } = {}) {
  const calls: { method: string; path: string; body?: Record<string, unknown>; auth: string | null }[] = [];
  let n = 0;
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path: u.pathname, body, auth: new Headers(init?.headers).get("Authorization") });
    const key = `${method} ${u.pathname}`;
    const forced = opts.status?.[key];
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (forced) return json(forced, { message: "forced" });
    if (u.origin !== "https://api.github.com") return json(500, {});
    if (key.endsWith("/git/ref/heads/gh-pages")) return opts.branchExists ? json(200, { object: { sha: "parent1" } }) : json(404, { message: "Not Found" });
    if (key.endsWith("/git/blobs")) return json(201, { sha: `blob${++n}` });
    if (key.endsWith("/git/trees")) return json(201, { sha: "tree1" });
    if (key.endsWith("/git/commits")) return json(201, { sha: "commit1" });
    if (key.endsWith("/git/refs") || key.includes("/git/refs/heads/")) return json(200, { ref: "refs/heads/gh-pages" });
    if (method === "POST" && key.endsWith("/pages")) return opts.pagesOn ? json(409, { message: "already enabled" }) : json(201, { html_url: "https://tal.github.io/garden/" });
    if (method === "PUT" && key.endsWith("/pages")) return new Response(null, { status: 204 });
    if (method === "GET" && key.endsWith("/pages")) return json(200, { html_url: "https://garden.example.com/" });
    return json(404, { message: "no route" });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const SITE: SiteFile[] = [
  { path: "index.html", data: "<h1>hi</h1>" },
  { path: "notes/a.html", data: "<p>a</p>" },
  { path: "img/x.png", data: new Uint8Array([1, 2, 3]) },
  { path: ".nojekyll", data: "" },
];

describe("deploy (4.18)", () => {
  it("GitHub Pages, new branch: blobs for binaries, one tree with exactly the site, a root commit, the ref, Pages on", async () => {
    const { f, calls } = fakeGitHub();
    const res = await deployToGitHubPages(SITE, { owner: "tal", repo: "garden", token: "tok" }, { fetch: f });
    expect(res).toEqual({ url: "https://tal.github.io/garden/", commit: "commit1", branch: "gh-pages" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /repos/tal/garden/git/ref/heads/gh-pages",
      "POST /repos/tal/garden/git/blobs",
      "POST /repos/tal/garden/git/trees",
      "POST /repos/tal/garden/git/commits",
      "POST /repos/tal/garden/git/refs",
      "POST /repos/tal/garden/pages",
    ]);
    expect(calls.every((c) => c.auth === "Bearer tok")).toBe(true);
    expect(calls[1].body).toEqual({ content: "AQID", encoding: "base64" });
    const tree = calls[2].body!.tree as { path: string; sha?: string; content?: string }[];
    expect(tree.map((e) => e.path)).toEqual(["index.html", "notes/a.html", "img/x.png", ".nojekyll"]);
    expect(tree[2]).toEqual({ path: "img/x.png", mode: "100644", type: "blob", sha: "blob1" });
    expect(calls[2].body).not.toHaveProperty("base_tree");
    expect(calls[3].body).toEqual({ message: "Publish site from Lumen", tree: "tree1", parents: [] });
    expect(calls[4].body).toEqual({ ref: "refs/heads/gh-pages", sha: "commit1" });
  });

  it("GitHub Pages, existing branch: on top of its last commit, no force; Pages already on keeps its address", async () => {
    const { f, calls } = fakeGitHub({ branchExists: true, pagesOn: true });
    const res = await deployToGitHubPages(SITE, { owner: "tal", repo: "garden", token: "tok" }, { fetch: f, message: "Update" });
    expect(res.url).toBe("https://garden.example.com/");
    const commit = calls.find((c) => c.path.endsWith("/git/commits"))!;
    expect(commit.body).toMatchObject({ message: "Update", parents: ["parent1"] });
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toBe("/repos/tal/garden/git/refs/heads/gh-pages");
    expect(patch.body).toEqual({ sha: "commit1", force: false });
  });

  it("says what is wrong: bad token, no access, empty repository, bad names — and sends nothing for bad names", async () => {
    const bad = fakeGitHub({ status: { "GET /repos/tal/garden/git/ref/heads/gh-pages": 401 } });
    await expect(deployToGitHubPages(SITE, { owner: "tal", repo: "garden", token: "x" }, { fetch: bad.f })).rejects.toThrow(/401/);
    const empty = fakeGitHub({ status: { "POST /repos/tal/garden/git/trees": 409 } });
    await expect(deployToGitHubPages(SITE, { owner: "tal", repo: "garden", token: "x" }, { fetch: empty.f })).rejects.toThrow(/empty/);
    const names = fakeGitHub();
    await expect(deployToGitHubPages(SITE, { owner: "tal/../x", repo: "garden", token: "x" }, { fetch: names.f })).rejects.toBeInstanceOf(DeployError);
    await expect(deployToGitHubPages(SITE, { owner: "tal", repo: "garden", branch: "../main", token: "x" }, { fetch: names.f })).rejects.toBeInstanceOf(DeployError);
    expect(names.calls).toEqual([]);
  });

  it("the .zip holds the site's files at the root", async () => {
    const z = await siteZip(SITE);
    const back = await unzip(z.buffer);
    expect([...back.keys()].sort()).toEqual([".nojekyll", "img/x.png", "index.html", "notes/a.html"]);
    expect(new TextDecoder().decode(back.get("notes/a.html"))).toBe("<p>a</p>");
    expect([...back.get("img/x.png")!]).toEqual([1, 2, 3]);
  });
});
