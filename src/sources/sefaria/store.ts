/**
 * Sefaria passages in the vault (plan W5.1).
 *
 *  - Offline copy, made only when the user asks ("Save for offline"):
 *    `Sources/Sefaria/<Book.chapter.verse>.md`, one note per reference.
 *    Its frontmatter records every version's title, licence, licence deed
 *    and source; its body holds the text of the FREE versions only. A
 *    link-only version is listed with its link, never with its text.
 *  - Lookup reads that note first: a saved source opens with no network
 *    request at all, online or not.
 *  - The quote inserted into a note carries its own attribution line
 *    (licence per version) and a `[[Book.chapter.verse|…]]` link, so the
 *    verse is a node in the graph and every note that quotes it is found.
 */

import { fetchPassage, type Passage, type PassageVersion } from "./client";
import { parseSourceRef, sourceRefsIn, type SourceRef } from "./refs";

export const SOURCES_DIR = "Sources/Sefaria";

export interface SourceStorage {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
}

export const sourceNotePath = (ref: SourceRef) => `${SOURCES_DIR}/${ref.key}.md`;

const yamlString = (s: string) => JSON.stringify(s);

/** The offline copy of a passage, as a note. */
export function renderSourceNote(p: Passage, retrieved: string): string {
  const fm = [
    "---",
    "type: source",
    "source: sefaria",
    `ref: ${yamlString(p.ref.tref)}`,
    `heRef: ${yamlString(p.heRef ?? p.ref.he)}`,
    `url: ${p.ref.url}`,
    `retrieved: ${retrieved}`,
    "versions:",
    ...p.versions.flatMap((v) => [
      `  - language: ${yamlString(v.language)}`,
      `    title: ${yamlString(v.title)}`,
      `    license: ${yamlString(v.license)}`,
      ...(v.licenseUrl ? [`    licenseUrl: ${v.licenseUrl}`] : []),
      ...(v.source ? [`    versionSource: ${yamlString(v.source)}`] : []),
      `    copied: ${v.free}`,
    ]),
    "---",
    "",
  ];
  const body = [`# ${p.heRef ?? p.ref.he}`, ""];
  for (const v of p.versions) {
    body.push(`## ${v.title || v.language} (${v.license})`, "");
    if (v.free && v.text) body.push(...v.text.map((t) => `${t}`), "");
    else body.push(`Not copied: ${v.license}. Read it on [Sefaria](${p.ref.url}).`, "");
  }
  return fm.join("\n") + body.join("\n");
}

/** A saved source note back as a passage (the text of free versions only). */
export function parseSourceNote(md: string): Passage | null {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(md);
  if (!m) return null;
  const fm = m[1];
  const refStr = /^ref: (.*)$/m.exec(fm)?.[1];
  const ref = refStr ? parseSourceRef(JSON.parse(refStr)) : null;
  if (!ref) return null;
  const heRef = /^heRef: (.*)$/m.exec(fm)?.[1];
  const versions: PassageVersion[] = [];
  const blocks = fm.split(/\n {2}- /).slice(1);
  const sections = m[2].split(/\n## /).slice(1);
  blocks.forEach((b, i) => {
    const field = (k: string) => {
      const v = new RegExp(`^(?: {4})?${k}: (.*)$`, "m").exec(b)?.[1];
      return v === undefined ? undefined : v.startsWith('"') ? (JSON.parse(v) as string) : v;
    };
    const language = field("language") ?? "";
    const free = field("copied") === "true";
    const sec = sections[i] ?? "";
    const lines = sec.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
    versions.push({
      language,
      direction: language === "he" ? "rtl" : "ltr",
      title: field("title") ?? "",
      source: field("versionSource") ?? null,
      license: field("license") ?? "unknown",
      licenseUrl: field("licenseUrl") ?? null,
      free,
      text: free ? lines : null,
      isSource: language === "he",
    });
  });
  return { ref, heRef: heRef ? (JSON.parse(heRef) as string) : null, versions };
}

export interface LookupResult {
  passage: Passage;
  /** Where it came from: the saved offline copy, or Sefaria. */
  from: "vault" | "network";
}

/** The passage: the offline copy when there is one (no request), else Sefaria. */
export async function lookupPassage(ref: SourceRef, deps: { storage: SourceStorage; fetch: typeof fetch }): Promise<LookupResult> {
  const saved = await deps.storage.read(sourceNotePath(ref));
  const parsed = saved ? parseSourceNote(saved) : null;
  if (parsed) return { passage: parsed, from: "vault" };
  return { passage: await fetchPassage(ref, deps.fetch), from: "network" };
}

/** "Save for offline": write the source note (free text only). The user asked for it. */
export async function savePassage(p: Passage, storage: SourceStorage, today = new Date().toISOString().slice(0, 10)): Promise<string> {
  const path = sourceNotePath(p.ref);
  await storage.write(path, renderSourceNote(p, today));
  return path;
}

const LANG_NAME: Record<string, string> = { he: "עברית", en: "English" };

/**
 * The quote inserted into a note: the free versions' text, each version's
 * title and licence, a link to Sefaria, and the verse link that makes it a
 * graph node. A link-only version shows only its title, licence and link.
 */
export function quoteBlock(p: Passage): string {
  const title = p.heRef ?? p.ref.he;
  const lines = [`> **[[${p.ref.key}|${title}]]**`, ">"];
  for (const v of p.versions) {
    if (!v.free || !v.text?.length) continue;
    for (const t of v.text) lines.push(`> ${t}`);
    lines.push(">");
  }
  const credits = p.versions.map((v) => {
    const lic = v.licenseUrl ? `[${v.license}](${v.licenseUrl})` : v.license;
    return `${LANG_NAME[v.language] ?? v.language}: ${v.title} (${lic})${v.free ? "" : " — link only"}`;
  });
  lines.push(`> — [Sefaria](${p.ref.url}) · ${credits.join(" · ")}`);
  return lines.join("\n");
}

/** Notes that cite this verse (wiki links or Sefaria links), by path. */
export function notesCiting(ref: SourceRef, notes: Array<{ path: string; content: string }>): string[] {
  return notes.filter((n) => !n.path.startsWith(`${SOURCES_DIR}/`) && sourceRefsIn(n.content).some((r) => r.key === ref.key)).map((n) => n.path);
}
