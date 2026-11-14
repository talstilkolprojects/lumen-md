/**
 * Wiki-link navigation in the preview. `[[Target]]` renders as an in-page
 * anchor (`#target`) — right for headings in the same note — but when the
 * note has no such heading the reader means another note: open the
 * workspace file whose name (or path) matches the target.
 */

import { slug as headingSlug } from "github-slugger";
import { decodeWikiPath } from "../lib/wikiPath";

/**
 * Split `Note#Heading` into the note and the heading fragment. A target
 * without `#` has no fragment; `#Heading` alone has an empty note.
 */
export function splitWikiTarget(target: string): { note: string; heading: string | null } {
  const hash = target.indexOf("#");
  if (hash === -1) return { note: target.trim(), heading: null };
  const heading = target.slice(hash + 1).trim();
  return { note: target.slice(0, hash).trim(), heading: heading || null };
}

/**
 * Workspace path for a wiki target, matching file name or path,
 * case-insensitively. A file named exactly as written wins over a note that
 * matches without its extension: `[[paper.pdf]]` is the PDF, not its
 * companion note `paper.pdf.md` (plan 4.14).
 */
export function resolveWikiTarget(target: string, paths: readonly string[]): string | null {
  // Generated links percent-encode the characters that are wiki syntax
  // (`draft%232.pdf` for `draft#2.pdf`) and whitespace at either end
  // (`%20paper.pdf`, plan 4.14). Such a target is most likely a generated
  // link, so the file it was made for (decoded) wins over a file literally
  // named with the escape (review #272, step 2.24). The decoded name is not
  // trimmed again: its edge whitespace was encoded on purpose (step 2.20).
  const written = target.trim();
  const decoded = decodeWikiPath(written);
  if (decoded !== written) return resolveExact(decoded, paths) ?? resolveExact(written, paths);
  return resolveExact(written, paths);
}

/** `target` is already trimmed (or deliberately keeps its decoded edge whitespace). */
function resolveExact(target: string, paths: readonly string[]): string | null {
  const raw = target.toLowerCase();
  const want = raw.replace(/\.(md|markdown)$/, "");
  if (!want.trim()) return null;
  const strip = (p: string) => p.toLowerCase().replace(/\.(md|markdown)$/, "");
  const name = (p: string) => p.split("/").pop() ?? p;
  return (
    paths.find((p) => p.toLowerCase() === raw) ??
    paths.find((p) => strip(p) === want) ??
    paths.find((p) => name(p).toLowerCase() === raw) ??
    paths.find((p) => strip(name(p)) === want) ??
    null
  );
}

/**
 * Click handler for the preview root. Returns true when it took over the
 * click (opened a note); same-note heading anchors keep their default.
 */
export function handleWikiLinkClick(
  e: { target: EventTarget | null; preventDefault(): void },
  root: HTMLElement,
  listPaths: () => Promise<string[]>,
  open: (path: string, heading?: string) => void,
): boolean {
  const el = (e.target as Element | null)?.closest?.("a.wiki-link[data-wiki-target]");
  if (!el) return false;
  const href = el.getAttribute("href") ?? "";
  const id = href.startsWith("#") ? decodeURIComponent(href.slice(1)) : "";
  // A heading with that id in this note: keep the in-page jump. Rendered
  // heading ids come from rehype-slug (Unicode-aware), so also try its slug
  // of the target — `[[שלום]]` to a Hebrew heading here.
  const targetId = headingSlug(el.getAttribute("data-wiki-target") ?? "");
  const byId = (want: string) => (want ? Array.from(root.querySelectorAll("[id]")).find((n) => n.id === want) : undefined);
  if (byId(id)) return false;
  const here = byId(targetId);
  if (here) {
    e.preventDefault();
    here.scrollIntoView({ block: "start" });
    return true;
  }
  // `[[Note#Heading]]` names the note before the `#`; the heading is
  // carried through so the opened note can scroll to it. `[[#Heading]]`
  // is same-note only — nothing to open.
  const { note, heading } = splitWikiTarget(el.getAttribute("data-wiki-target") ?? "");
  if (!note) return false;
  e.preventDefault();
  void listPaths()
    .then((paths) => {
      const path = resolveWikiTarget(note, paths);
      if (!path) return;
      if (heading) open(path, heading);
      else open(path);
    })
    .catch(() => {
      /* no workspace (OPFS unavailable) — nothing to open */
    });
  return true;
}

/**
 * Scroll the preview to the heading with id `headingId` once it appears —
 * the note that was just opened renders asynchronously. Polls briefly and
 * gives up quietly (the heading may not exist in that note).
 */
export function scrollToHeadingWhenRendered(
  headingId: string,
  {
    intervalMs = 100,
    timeoutMs = 3000,
    doc = document,
    docKey,
  }: { intervalMs?: number; timeoutMs?: number; doc?: Document; docKey?: string } = {},
): void {
  const started = Date.now();
  const tick = () => {
    // With `docKey`, only a preview that already shows the opened note
    // counts: the previous note may still be mounted, with the same heading.
    const roots = Array.from(doc.querySelectorAll<HTMLElement>("[data-preview-root]")).filter(
      (r) => docKey === undefined || r.getAttribute("data-preview-doc") === docKey,
    );
    const el = roots.flatMap((r) => Array.from(r.querySelectorAll("[id]"))).find((n) => n.id === headingId);
    if (el) {
      el.scrollIntoView({ block: "start" });
      return;
    }
    if (Date.now() - started < timeoutMs) setTimeout(tick, intervalMs);
  };
  // First look after a beat, so the previous note's DOM is gone.
  setTimeout(tick, intervalMs);
}
