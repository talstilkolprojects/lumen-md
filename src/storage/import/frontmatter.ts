/**
 * Frontmatter for imported notes: the dates, tags and properties the
 * source tool kept outside the text become YAML properties, so Bases,
 * Dataview and the properties panel see them.
 */
import { parse, stringify } from "yaml";

export type Props = Record<string, unknown>;

const FM = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** Split a note into its frontmatter (parsed; {} when none or broken) and body. */
export function splitFrontmatter(text: string): { props: Props; body: string; broken: boolean } {
  const m = FM.exec(text);
  if (!m) return { props: {}, body: text, broken: false };
  try {
    const v = parse(m[1]) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return { props: v as Props, body: text.slice(m[0].length), broken: false };
    return { props: {}, body: text.slice(m[0].length), broken: v !== null && v !== undefined };
  } catch {
    return { props: {}, body: text, broken: true };
  }
}

/**
 * `body` with `props` as its frontmatter. Properties the note already has
 * stay; the imported ones fill in. A broken frontmatter is left as it is
 * (nothing of the user's text is rewritten).
 */
export function withFrontmatter(props: Props, body: string): string {
  const clean = Object.fromEntries(Object.entries(props).filter(([, v]) => !isEmpty(v)));
  const existing = splitFrontmatter(body);
  if (existing.broken) return body;
  const merged = { ...clean, ...existing.props };
  if (!Object.keys(merged).length) return existing.body;
  const yaml = stringify(merged, { lineWidth: 0 }).trimEnd();
  const rest = existing.body.replace(/^\r?\n+/, "");
  return `---\n${yaml}\n---\n${rest ? `\n${rest}` : ""}`;
}

/** A tag as a property value: no `#`, spaces → `-` (a tag cannot hold a space). */
export function tagValue(tag: string): string {
  return tag.trim().replace(/^#+/, "").replace(/\s+/g, "-");
}

/** An ISO date-time from a Date or ms, `undefined` when invalid. Seconds kept, milliseconds dropped. */
export function isoDate(d: Date | number | undefined | null): string | undefined {
  if (d === undefined || d === null) return undefined;
  const date = typeof d === "number" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
