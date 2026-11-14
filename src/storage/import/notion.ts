/**
 * Notion: an export of a workspace or a page (Settings → Export), as
 * "Markdown & CSV" or as "HTML". Names lose Notion's 32-hex ids, links
 * follow the pages, and each database becomes a `.base` file (plan W1.11)
 * with the same columns, its rows notes whose properties are the row's
 * cells — so the table, its filters and its views open in Lumen and in
 * Obsidian.
 */
import { stringify } from "yaml";
import { inferOrder, parseNotionDate, type DateOrder } from "./notionDates";
import { stripNotionIds } from "../exportAll";
import { claimPath, dirOf, mdDest, mdEmbed, relativeTo, resolveRel, safePath, stemOf } from "./names";
import { decodeEntities, htmlToNote } from "./html";
import { splitFrontmatter, withFrontmatter, type Props } from "./frontmatter";
import { emptyVault, type ConvertedVault } from "./types";

/* ─── CSV ────────────────────────────────────────────────────────────── */

/** RFC 4180 rows (quoted fields, doubled quotes, newlines inside quotes; a BOM dropped). */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^\u{feff}/u, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f !== ""));
}

/* ─── Cell values ────────────────────────────────────────────────────── */

/**
 * A Notion date cell → `2024-01-31` / `2024-01-31T10:00`, else null. Any of
 * the export languages (./notionDates.ts, plan W11.P1), not only English;
 * `order` settles a numeric `03/04/2026` the way its column does.
 */
export function notionDate(s: string, order?: DateOrder): string | null {
  return parseNotionDate(s, { order });
}

/** `Page (Page%20<id>.md)` or `Page (https://www.notion.so/…)` → the page title. */
const RELATION = /^(.+?) \(((?:[^()]|\([^()]*\))+\.(?:md|html)|https:\/\/www\.notion\.so\/[^)]+)\)$/;

/** A column's values typed the way Bases filters and sorts them: every cell of a column decides together. */
export function typeColumn(cells: string[]): (string | number | boolean | string[] | null)[] {
  const filled = cells.filter((c) => c.trim() !== "");
  if (filled.length && filled.every((c) => /^(Yes|No)$/.test(c.trim()))) return cells.map((c) => (c.trim() === "" ? null : c.trim() === "Yes"));
  if (filled.length && filled.every((c) => /^-?\d+(\.\d+)?$/.test(c.trim().replace(/,/g, "")))) return cells.map((c) => (c.trim() === "" ? null : Number(c.trim().replace(/,/g, ""))));
  // A numeric date column settles day-first or month-first together (one 23/09/2026 makes 03/04/2026 the 3rd of April).
  const order = inferOrder(filled);
  if (filled.length && filled.every((c) => notionDate(c, order) !== null)) return cells.map((c) => (c.trim() === "" ? null : notionDate(c, order)));
  if (filled.length && filled.every((c) => c.split(/, (?=[^,]+ \()/).every((p) => RELATION.test(p.trim())))) {
    return cells.map((c) => (c.trim() === "" ? null : c.split(/, (?=[^,]+ \()/).map((p) => `[[${RELATION.exec(p.trim())![1]}]]`)));
  }
  return cells.map((c) => (c.trim() === "" ? null : c));
}

/* ─── The converter ──────────────────────────────────────────────────── */

const ID = /\s[0-9a-f]{32}(?=(\.[a-z0-9]+)?$)/i;

interface Database {
  /** The .base file, relative to the import folder. */
  base: string;
  /** The rows' folder, relative to the import folder. */
  folder: string;
  title: string;
  columns: string[];
  rows: string[][];
}

/** The `.base` text for a database: every row of its folder, the columns in their order. */
export function databaseBase(db: Pick<Database, "title" | "columns">, vaultFolder: string): string {
  const [titleCol, ...rest] = db.columns;
  const id = (c: string) => `note.${c}`;
  const properties: Record<string, { displayName: string }> = { "file.name": { displayName: titleCol } };
  const doc = {
    filters: { and: [`file.inFolder(${JSON.stringify(vaultFolder)})`, 'file.ext == "md"'] },
    properties,
    views: [{ type: "table", name: db.title, order: ["file.name", ...rest.map(id)] }],
  };
  return `# ${db.title} — imported from Notion\n${stringify(doc, { lineWidth: 0 })}`;
}

export interface NotionOptions {
  /** The vault folder the import goes into (`Imported/<name>`), for the bases' folder filters. */
  folder: string;
}

export function convertNotion(files: Map<string, Uint8Array>, opts: NotionOptions): ConvertedVault {
  const vault = emptyVault();
  const taken = new Set<string>();
  const dec = new TextDecoder();
  const finalOf = new Map<string, string>();
  const paths = [...files.keys()];
  // Notion writes `DB.csv` and, in newer exports, `DB_all.csv` (every row,
  // not only the default view's): the `_all` one wins.
  const csvs = paths.filter((p) => /\.csv$/i.test(p));
  const csvSkip = new Set(csvs.filter((p) => !/_all\.csv$/i.test(p) && csvs.includes(p.replace(/\.csv$/i, "_all.csv"))));
  for (const p of paths) {
    if (csvSkip.has(p)) {
      vault.skipped.push({ path: p, reason: "duplicate" });
      continue;
    }
    const clean = safePath(stripNotionIds(p.replace(/_all\.csv$/i, ".csv")));
    const target = /\.csv$/i.test(clean) ? clean.replace(/\.csv$/i, ".base") : /\.html?$/i.test(clean) ? clean.replace(/\.html?$/i, ".md") : clean;
    finalOf.set(p, claimPath(taken, target));
  }
  // Links to the view's CSV go to the database too.
  for (const p of csvSkip) finalOf.set(p, finalOf.get(p.replace(/\.csv$/i, "_all.csv"))!);
  const dbs: Database[] = [];
  for (const p of csvs) {
    if (csvSkip.has(p)) continue;
    const rows = parseCsv(dec.decode(files.get(p)!));
    if (!rows.length) {
      vault.skipped.push({ path: p, reason: "empty" });
      continue;
    }
    const base = finalOf.get(p)!;
    dbs.push({ base, folder: base.replace(/\.base$/, ""), title: stemOf(base), columns: rows[0].map((c) => c.trim()), rows: rows.slice(1) });
  }
  const rowProps = new Map<string, Props>();
  // HTML export: databases are pages holding `<table class="collection-content">`.
  const htmlDbs = new Set<string>();
  for (const p of paths) {
    if (!/\.html?$/i.test(p)) continue;
    const html = dec.decode(files.get(p)!);
    const table = /<table class="collection-content">([\s\S]*?)<\/table>/i.exec(html);
    if (!table) continue;
    const head = /<thead>([\s\S]*?)<\/thead>/i.exec(table[1])?.[1] ?? "";
    const columns = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, "")).trim());
    if (!columns.length) continue;
    const rows = [...table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
      .slice(1)
      .map((r) => [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => decodeEntities(c[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim()));
    const md = finalOf.get(p)!;
    const base = claimPath(taken, md.replace(/\.md$/, ".base"));
    finalOf.set(p, base);
    htmlDbs.add(p);
    dbs.push({ base, folder: md.replace(/\.md$/, ""), title: stemOf(md), columns, rows });
  }
  const notesByPath = new Map([...finalOf.entries()].filter(([, t]) => t.endsWith(".md")).map(([s, t]) => [t.normalize("NFC").toLowerCase(), s]));
  for (const db of dbs) {
    const typed = db.columns.map((_, i) => typeColumn(db.rows.map((r) => r[i] ?? "")));
    db.rows.forEach((r, ri) => {
      const title = (r[0] ?? "").trim() || "Untitled";
      const props: Props = {};
      db.columns.slice(1).forEach((c, ci) => {
        const v = typed[ci + 1][ri];
        if (v !== null) props[c] = v;
      });
      const want = `${db.folder}/${safePath(title)}.md`.normalize("NFC").toLowerCase();
      const src = notesByPath.get(want);
      if (src) rowProps.set(src, props);
      else {
        // A row with no page of its own (an empty row page is not exported): its properties as a note.
        const path = claimPath(taken, `${db.folder}/${safePath(title)}.md`);
        vault.notes.set(path, withFrontmatter(props, `# ${title}\n`));
      }
    });
    vault.notes.set(db.base, databaseBase(db, opts.folder ? `${opts.folder}/${db.folder}` : db.folder));
  }
  // Links: archive path (decoded, relative) → where it went (relative to the import folder).
  const targetOf = (href: string, from: string): { target: string; suffix: string } | null => {
    if (/^[a-z]+:/i.test(href) || href.startsWith("#")) return null;
    const cut = href.search(/[?#]/);
    const [path, suffix] = cut < 0 ? [href, ""] : [href.slice(0, cut), href.slice(cut)];
    let decoded = path;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return null;
    }
    const target = finalOf.get(resolveRel(dirOf(from), decoded));
    // A `#heading` names Notion's block ids, which do not survive: the link goes to the page.
    return target ? { target, suffix: suffix.startsWith("#") ? "" : suffix } : null;
  };
  const rewrite = (href: string, from: string): string | null => {
    const to = targetOf(href, from);
    return to ? `${mdDest(relativeTo(dirOf(finalOf.get(from)!), to.target))}${to.suffix}` : null;
  };
  for (const [p, data] of files) {
    if (csvSkip.has(p) || /\.csv$/i.test(p) || htmlDbs.has(p)) continue;
    const target = finalOf.get(p)!;
    if (/\.md$/i.test(p)) {
      let text = dec.decode(data).replace(/\]\((<[^>]+>|[^)\s]+)\)/g, (m, dest: string) => {
        const to = rewrite(dest.replace(/^<|>$/g, ""), p);
        return to ? `](${to})` : m;
      });
      const props = rowProps.get(p);
      if (props) {
        // The Markdown export repeats the row's cells under the title (`Status: Done`): they are properties now.
        const { body } = splitFrontmatter(text);
        const keys = new Set(Object.keys(props).map((k) => k.toLowerCase()));
        const lines = body.split("\n");
        const start = lines.findIndex((l) => /^#\s/.test(l)) + 1;
        let i = start;
        while (i < lines.length && (!lines[i].trim() || (/^([^:]+): /.test(lines[i]) && keys.has(/^([^:]+): /.exec(lines[i])![1].trim().toLowerCase())))) i++;
        text = withFrontmatter(props, [...lines.slice(0, start), ...(i > start ? [""] : []), ...lines.slice(i)].join("\n"));
      }
      vault.notes.set(target, text);
    } else if (/\.html?$/i.test(p)) {
      const html = dec.decode(data);
      const title = decodeEntities(/<h1 class="page-title">([\s\S]*?)<\/h1>/i.exec(html)?.[1]?.replace(/<[^>]+>/g, "") ?? "").trim() || stemOf(target);
      const props: Props = { ...(rowProps.get(p) ?? {}) };
      const propTable = /<table class="properties">([\s\S]*?)<\/table>/i.exec(html)?.[1] ?? "";
      for (const m of propTable.matchAll(/<tr[^>]*>\s*<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/gi)) {
        const k = decodeEntities(m[1].replace(/<[^>]+>/g, "")).trim();
        const v = decodeEntities(m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
        if (k && v && !(k in props)) props[k] = notionDate(v) ?? v;
      }
      const page = /<div class="page-body">([\s\S]*)<\/div>\s*<\/article>/i.exec(html)?.[1] ?? /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
      const fromDir = dirOf(target);
      const body = htmlToNote(`<div>${page}</div>`, {
        image: (src) => {
          const to = targetOf(src, p);
          if (to) return mdEmbed(to.target, fromDir);
          if (!/^[a-z]+:/i.test(src)) vault.warnings.push({ path: target, reason: "missingAttachment", detail: src });
          return null;
        },
        link: (href, text) => {
          const to = rewrite(href, p);
          return to ? `[${text.replace(/[[\]]/g, "")}](${to})` : null;
        },
      });
      vault.notes.set(target, withFrontmatter(props, `# ${title}\n\n${body.trim()}\n`));
    } else if (/(^|\/)\.DS_Store$/.test(p)) {
      vault.skipped.push({ path: p, reason: "appFolder" });
    } else {
      vault.sourceAttachments++;
      vault.attachments.set(target, data);
    }
  }
  return vault;
}

export const looksLikeNotion = (paths: string[]) => paths.filter((p) => p.split("/").some((seg) => ID.test(seg))).length >= Math.max(1, paths.length / 2);
