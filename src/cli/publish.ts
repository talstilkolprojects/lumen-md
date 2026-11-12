/**
 * `lumen publish` — render a folder of Markdown files to a static website.
 *
 *   lumen publish <dir|file> --out <dir>
 *
 * - Every `.md` / `.markdown` file becomes an `.html` page at the same relative
 *   path, rendered with the editor's own pipeline via `renderHtmlDocument`
 *   (the HTML export).
 * - Relative links to other Markdown files (`[x](notes/a.md#part)`) are
 *   rewritten to their `.html` counterparts; external links are untouched.
 * - Every other file (images, PDFs, …) is copied verbatim, so relative asset
 *   references keep working.
 * - `index.html` lists every page. If the source has its own root `index.md`,
 *   that page becomes `index.html` with the page list appended to it.
 * - Hidden entries, `node_modules`, and the output folder itself are skipped.
 *
 * Node-only (uses node:fs); bin/lumen.ts is the thin argv wrapper.
 */
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { renderHtmlDocument, escapeHtml } from "../storage/exportHtml";
import { MD_RE, PUBLISH_CSS, encodePath, pageTitle, rewriteMarkdownLinks, rewriteWikiLinks } from "../publish/siteLinks";
import { resolveWikiTarget, splitWikiTarget } from "../renderer/wikiLinks";
import { prepareForExport } from "../lib/redaction";
import { cleanImageBytes } from "../lib/imageMetadata";

/** Photos whose published copy loses its metadata (plan W5.11). */
const PHOTO_TYPE: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

export { PUBLISH_CSS, encodePath, pageTitle, rewriteMarkdownLinks, rewriteWikiLinks } from "../publish/siteLinks";

export interface PublishPage {
  /** Source path relative to the input root, POSIX separators. */
  source: string;
  /** Output path relative to the out dir, POSIX separators. */
  output: string;
  title: string;
}

export interface PublishResult {
  pages: PublishPage[];
  /** Non-Markdown files copied (relative POSIX paths); photos without their metadata. */
  assets: string[];
  /** Absolute path of the written index.html. */
  index: string;
  /**
   * Source files that were NOT written because their output path collides
   * with a generated file (a page, the index or style.css). Generated
   * targets always win so every Markdown page and the index survive. A
   * photo whose metadata can't be removed is skipped too.
   */
  skipped: { source: string; output: string; reason: string }[];
}


const toPosix = (p: string) => p.split(sep).join("/");





function walk(root: string, skip: string, out: string[] = [], dir = root): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
    const full = join(dir, ent.name);
    if (resolve(full) === skip) continue;
    if (ent.isDirectory()) walk(root, skip, out, full);
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

/** Insert markup just before the document's (last) closing </main>. */
function appendToMain(html: string, markup: string): string {
  const at = html.lastIndexOf("</main>");
  return at < 0 ? html + markup : `${html.slice(0, at)}${markup}\n${html.slice(at)}`;
}

function pageList(pages: PublishPage[], hrefPrefix = ""): string {
  const items = pages
    .map((p) => {
      const sub = dirname(p.output) === "." ? "" : `<small>${escapeHtml(dirname(p.output))}/</small>`;
      return `<li><a href="${escapeHtml(hrefPrefix + encodePath(p.output))}">${escapeHtml(p.title)}</a>${sub}</li>`;
    })
    .join("\n");
  return `<ul class="lumen-site-pages">\n${items}\n</ul>`;
}


/** Records what the last publish wrote, so a republish can remove it first. */
export const PUBLISH_MANIFEST = ".lumen-publish.json";

/**
 * Remove the files a previous publish into `outAbs` wrote (per its
 * manifest) and the folders they leave empty. Only listed files are
 * touched — anything else in the folder is left alone — so a page or
 * asset that was removed or changed shape (a `guide.html/` folder that is
 * now a page) can't linger or block the new write.
 */
export function clearPreviousPublish(outAbs: string): void {
  let listed: unknown;
  try {
    listed = (JSON.parse(readFileSync(join(outAbs, PUBLISH_MANIFEST), "utf8")) as { files?: unknown }).files;
  } catch {
    return; // no (readable) manifest: nothing we know we wrote
  }
  if (!Array.isArray(listed)) return;
  const dirs = new Set<string>();
  for (const rel of listed) {
    if (typeof rel !== "string" || !rel) continue;
    const target = resolve(outAbs, ...rel.split("/"));
    const r = relative(outAbs, target);
    if (!r || r.startsWith("..") || isAbsolute(r)) continue; // never outside the output folder
    // Every folder between the output root and the file must be a real
    // directory: a symlinked one would make unlink delete a file outside.
    if (!realDirsBetween(outAbs, target)) continue;
    try {
      if (!lstatSync(target).isFile()) continue;
      unlinkSync(target);
    } catch {
      continue;
    }
    for (let d = dirname(target); d !== outAbs && relative(outAbs, d) && !relative(outAbs, d).startsWith(".."); d = dirname(d)) {
      dirs.add(d);
    }
  }
  // Deepest first, so a parent is empty by the time it's checked.
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      if (readdirSync(d).length === 0) rmdirSync(d);
    } catch {
      /* why: already gone or not empty */
    }
  }
}

/** True when each path component strictly between `root` and `target` is a real directory (not a symlink). */
function realDirsBetween(root: string, target: string): boolean {
  const parts = relative(root, target).split(sep).slice(0, -1);
  let cur = root;
  for (const part of parts) {
    cur = join(cur, part);
    try {
      const st = lstatSync(cur);
      if (st.isSymbolicLink() || !st.isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Absolute path for writing `rel` inside `outAbs`, creating its folders,
 * without ever following a symlink in the output folder: a symlinked folder
 * on the way is refused, and a symlink standing at the target itself is
 * removed (the link, never what it points to) so the write creates a plain
 * file instead of overwriting the link's destination.
 */
export function prepareOutputPath(outAbs: string, rel: string): string {
  const parts = rel.split("/");
  let cur = outAbs;
  for (const part of parts.slice(0, -1)) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      mkdirSync(cur);
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(
        `Refusing to write ${rel}: ${toPosix(relative(outAbs, cur))} in the output folder is ${st.isSymbolicLink() ? "a symlink" : "not a folder"}.`,
      );
    }
  }
  const target = join(cur, parts[parts.length - 1]);
  try {
    if (lstatSync(target).isSymbolicLink()) unlinkSync(target);
  } catch {
    /* why: doesn't exist yet */
  }
  return target;
}

/**
 * Local files a rendered page references (`src` / `href`), resolved against
 * `root`: relative URLs only, inside `root`, existing regular files that
 * aren't Markdown. Used to bring a single published file's images along.
 */
export function referencedLocalFiles(html: string, fromDir: string, root: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/\s(?:src|href)="([^"]*)"/g)) {
    let url = m[1].replace(/&amp;/g, "&");
    if (!url || /^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(url)) continue;
    url = url.replace(/[?#].*$/, "");
    try {
      url = decodeURIComponent(url);
    } catch {
      continue;
    }
    const abs = resolve(fromDir, url);
    const r = relative(root, abs);
    if (!r || r.startsWith("..") || isAbsolute(r) || MD_RE.test(abs)) continue;
    // Never follow a symlink (at the file or a folder on the way): a
    // `logo.png -> /etc/passwd` must not be copied into the site.
    if (!realDirsBetween(root, abs)) continue;
    try {
      if (lstatSync(abs).isFile()) out.add(abs);
    } catch {
      /* why: missing — leave the link as is */
    }
  }
  return [...out];
}

/** Real path of `p`, resolving symlinks in its existing prefix (the rest may not exist yet). */
export function canonicalPath(p: string): string {
  const rest: string[] = [];
  let cur = resolve(p);
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

/** Most pages a single-file publish follows links to. */
const MAX_LINKED_PAGES = 1000;

/**
 * `start` plus every local Markdown page reachable from it through
 * relative links (inline `[x](page.md)`, reference definitions, `href=`),
 * staying inside `root` and never following symlinks. `start` first.
 */
export function linkedPages(start: string, root: string): string[] {
  const seen = new Set<string>([start]);
  const queue = [start];
  let mdUnderRoot: string[] | undefined;
  // Inline `](<dest with spaces>)` / `](dest)`, reference definitions
  // (`[x]: <dest>` / `[x]: dest`) and raw `href="…"`.
  const LINK_RE =
    /\]\(\s*(?:<([^>\n]+)>|([^)\s]+))|^\s{0,3}\[[^\]]+\]:\s*(?:<([^>\n]+)>|(\S+))|\bhref="([^"]+)"/gm;
  while (queue.length && seen.size < MAX_LINKED_PAGES) {
    const cur = queue.shift()!;
    let md: string;
    try {
      md = readFileSync(cur, "utf8");
    } catch {
      continue;
    }
    for (const m of md.matchAll(LINK_RE)) {
      let url = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "").replace(/&amp;/g, "&");
      if (!url || /^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(url)) continue;
      url = url.replace(/[?#].*$/, "");
      try {
        url = decodeURIComponent(url);
      } catch {
        continue;
      }
      if (!MD_RE.test(url)) continue;
      const abs = resolve(dirname(cur), url);
      const r = relative(root, abs);
      if (!r || r.startsWith("..") || isAbsolute(r) || seen.has(abs)) continue;
      if (!realDirsBetween(root, abs)) continue;
      try {
        if (!lstatSync(abs).isFile()) continue;
      } catch {
        continue;
      }
      seen.add(abs);
      queue.push(abs);
      if (seen.size >= MAX_LINKED_PAGES) break;
    }
    // `[[Note]]` / `[[Note#Heading|label]]`: resolved by name or path among
    // the Markdown files under the root, as the app resolves them.
    for (const m of md.matchAll(WIKI_RE)) {
      if (seen.size >= MAX_LINKED_PAGES) break;
      const { note } = splitWikiTarget(m[1].split("|")[0]);
      if (!note) continue;
      mdUnderRoot ??= walk(root, "")
        .filter((f) => MD_RE.test(f))
        .map((f) => toPosix(relative(root, f)));
      const rel = resolveWikiTarget(note, mdUnderRoot);
      if (!rel) continue;
      const abs = resolve(root, rel);
      if (seen.has(abs) || !realDirsBetween(root, abs)) continue;
      try {
        if (!lstatSync(abs).isFile()) continue;
      } catch {
        continue;
      }
      seen.add(abs);
      queue.push(abs);
    }
  }
  return [...seen];
}

const WIKI_RE = /\[\[([^\]\n]+)\]\]/g;

/** Publish `input` (a folder or a single .md file) as a static site in `outDir`. */
export async function publishSite(
  input: string,
  outDir: string,
  opts: { siteTitle?: string; keepImageMetadata?: boolean } = {},
): Promise<PublishResult> {
  // Compare and write through canonical paths: a symlinked input or --out
  // must not let the containment check below be bypassed.
  const inAbs = realpathSync(resolve(input));
  const outLexical = resolve(outDir);
  try {
    if (lstatSync(outLexical).isSymbolicLink()) {
      throw new Error(`Refusing to publish into ${outLexical}: the output folder is a symlink. Pass its real path.`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const outAbs = canonicalPath(outLexical);
  const st = statSync(inAbs);
  const root = st.isDirectory() ? inAbs : dirname(inAbs);
  // Writing into the source folder (or one of its ancestors) would overwrite
  // source files -- style.css, hand-written .html -- with no way to restore
  // them. An output folder *inside* the source is fine: walk() skips it.
  const rel = relative(outAbs, root);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error(
      `Refusing to publish into ${outAbs}: it is the source folder or contains it. Choose a separate --out folder.`,
    );
  }
  // A single file brings along the Markdown pages it links to (and theirs),
  // so its links to sibling pages aren't rewritten to pages that don't exist.
  const files = st.isDirectory() ? walk(root, outAbs).sort() : linkedPages(inAbs, root);
  const siteTitle = opts.siteTitle ?? basename(root);

  mkdirSync(outAbs, { recursive: true });
  clearPreviousPublish(outAbs);
  writeFileSync(prepareOutputPath(outAbs, "style.css"), PUBLISH_CSS);

  const mdFiles = files.filter((f) => MD_RE.test(f));
  const assets = files.filter((f) => !MD_RE.test(f));
  const singleFile = !st.isDirectory();

  const skipped: PublishResult["skipped"] = [];
  // Output paths are compared case-insensitively: on macOS/Windows file
  // systems `Guide.html` and `guide.html` are the same file.
  const key = (p: string) => p.toLowerCase();
  // Files we will write, and the directories their paths need. A new path
  // collides with a reserved file at the same path, with a reserved file
  // standing where one of its ancestor directories must go (`guide.html`
  // vs `guide.html/img.png`), or with a directory a reserved file needs.
  const reserved = new Map<string, string>();
  const reservedDirs = new Map<string, string>();
  const ancestors = (p: string) => {
    const parts = key(p).split("/");
    return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
  };
  const collision = (p: string): string | undefined =>
    reserved.get(key(p)) ??
    reservedDirs.get(key(p)) ??
    ancestors(p).map((a) => reserved.get(a)).find(Boolean);
  const reserve = (p: string, what: string) => {
    reserved.set(key(p), what);
    for (const a of ancestors(p)) if (!reservedDirs.has(a)) reservedDirs.set(a, `a folder needed by ${what}`);
  };
  reserve("style.css", "the site stylesheet");

  const pages: (PublishPage & { md: string })[] = [];
  for (const f of mdFiles) {
    const rel = toPosix(relative(root, f));
    let output = rel.replace(MD_RE, ".html");
    // The root index is always written as lowercase index.html — the name
    // the navigation links and PublishResult.index use on case-sensitive
    // hosts too.
    if (output.toLowerCase() === "index.html") output = "index.html";
    const taken = collision(output);
    if (taken) {
      skipped.push({ source: rel, output, reason: `collides with ${taken}` });
      continue;
    }
    reserve(output, `the page generated from ${rel}`);
    // W5.11: the published text is the export text: no <redact> passage, no hidden comment.
    const { text: md } = await prepareForExport(readFileSync(f, "utf8"), { keepImageMetadata: opts.keepImageMetadata ?? false });
    pages.push({ source: rel, output, title: pageTitle(md, rel), md });
  }
  if (!reserved.has(key("index.html"))) reserve("index.html", "the generated page index");
  const rootIndex = pages.find((p) => p.output === "index.html");
  const listed = pages
    .filter((p) => p !== rootIndex)
    .sort((a, b) => a.output.localeCompare(b.output));

  for (const p of pages) {
    const depth = p.output.split("/").length - 1;
    const up = "../".repeat(depth);
    const isIndex = p === rootIndex;
    const nav = isIndex
      ? ""
      : `<nav class="lumen-site-nav"><a href="${up}index.html">← ${escapeHtml(siteTitle)}</a></nav>\n`;
    let html = await renderHtmlDocument(p.md, {
      title: isIndex ? siteTitle : `${p.title} — ${siteTitle}`,
      head: `\n<link rel="stylesheet" href="${up}style.css" />`,
      before: nav,
    });
    html = rewriteMarkdownLinks(html, p.output);
    html = rewriteWikiLinks(html, p.output, pages);
    if (isIndex && listed.length) {
      html = appendToMain(html, pageList(listed));
    }
    // A single published file has no folder walk: bring along the local
    // files (images, downloads) it references.
    if (singleFile) {
      const pageDir = join(root, ...dirname(p.source).split("/"));
      for (const a of referencedLocalFiles(html, pageDir, root)) if (!assets.includes(a)) assets.push(a);
    }
    writeFileSync(prepareOutputPath(outAbs, p.output), html);
  }

  if (!rootIndex) {
    const body =
      `<h1>${escapeHtml(siteTitle)}</h1>\n` +
      (listed.length ? pageList(listed) : "<p>No pages.</p>");
    const html = await renderHtmlDocument("", {
      title: siteTitle,
      head: `\n<link rel="stylesheet" href="style.css" />`,
    });
    writeFileSync(prepareOutputPath(outAbs, "index.html"), appendToMain(html, body));
  }

  const assetRels: string[] = [];
  for (const a of assets) {
    const rel = toPosix(relative(root, a));
    const taken = collision(rel);
    if (taken) {
      skipped.push({ source: rel, output: rel, reason: `collides with ${taken}` });
      continue;
    }
    const photo = opts.keepImageMetadata ? undefined : PHOTO_TYPE[(rel.split(".").pop() ?? "").toLowerCase()];
    if (photo) {
      // A photo goes out without its location, time and camera details; one that can't be cleaned stays out.
      const r = await cleanImageBytes(new Uint8Array(readFileSync(a)), photo);
      if (!r || r.type !== photo) {
        skipped.push({ source: rel, output: rel, reason: "its photo metadata could not be removed" });
        continue;
      }
      reserve(rel, `the asset ${rel}`);
      writeFileSync(prepareOutputPath(outAbs, rel), r.bytes);
    } else {
      reserve(rel, `the asset ${rel}`);
      copyFileSync(a, prepareOutputPath(outAbs, rel));
    }
    assetRels.push(rel);
  }

  writeFileSync(
    prepareOutputPath(outAbs, PUBLISH_MANIFEST),
    JSON.stringify(
      { files: ["style.css", "index.html", ...pages.map((p) => p.output), ...assetRels].filter((f, i, a) => a.indexOf(f) === i) },
      null,
      2,
    ) + "\n",
  );

  return {
    pages: pages.map(({ source, output, title }) => ({ source, output, title })),
    assets: assetRels,
    index: join(outAbs, "index.html"),
    skipped,
  };
}
