/**
 * Sefaria's texts API (plan W5.1): one GET per reference,
 * `https://www.sefaria.org/api/v3/texts/{tref}?version=source&version=translation&return_format=text_only`
 * (no key needed; developers.sefaria.org, "Getting Started" and the
 * OpenAPI spec in Sefaria-Project/docs/openAPI.json). `text_only` drops
 * HTML and footnotes but keeps the letters exactly, niqqud and
 * cantillation included.
 *
 * What leaves the device: the reference only (e.g. "Genesis 1:1"). The
 * request is made because the user asked for that source, so it goes
 * through the privacy ledger as consented traffic and is listed there.
 *
 * Versions whose licence is not free are reduced to their title, licence
 * and link here: their text is dropped as soon as it is parsed and never
 * reaches a note, the vault or a cache.
 */

import { isFreeLicense, licenseLabel, licenseUrl } from "./license";
import type { SourceRef } from "./refs";

export const SEFARIA_API = "https://www.sefaria.org/api/v3/texts/";

export interface PassageVersion {
  /** "he", "en", … (Sefaria's actualLanguage, else its language). */
  language: string;
  direction: "rtl" | "ltr";
  title: string;
  /** Where Sefaria got the digital text. */
  source: string | null;
  license: string;
  licenseUrl: string | null;
  free: boolean;
  /** One string per verse; null for a link-only version. */
  text: string[] | null;
  isSource: boolean;
}

export interface Passage {
  ref: SourceRef;
  /** Sefaria's own Hebrew reference, when it gives one. */
  heRef: string | null;
  versions: PassageVersion[];
}

interface ApiVersion {
  text?: unknown;
  language?: string;
  actualLanguage?: string;
  direction?: string;
  versionTitle?: string;
  versionSource?: string;
  license?: string;
  isSource?: boolean;
}

/** Sefaria's text array, flattened to one string per verse. */
function flatten(text: unknown): string[] {
  if (typeof text === "string") return [text];
  if (Array.isArray(text)) return text.flatMap(flatten);
  return [];
}

export function apiUrl(ref: SourceRef): string {
  return `${SEFARIA_API}${encodeURIComponent(ref.tref)}?version=source&version=translation&return_format=text_only`;
}

/** The API response as a passage; non-free text dropped. Exported for tests. */
export function parseTextsResponse(ref: SourceRef, json: unknown): Passage {
  const body = (json ?? {}) as { versions?: ApiVersion[]; heRef?: string };
  const versions: PassageVersion[] = (body.versions ?? []).map((v) => {
    const free = isFreeLicense(v.license);
    const language = (v.actualLanguage || v.language || "").toLowerCase();
    return {
      language,
      direction: v.direction === "rtl" || (!v.direction && language === "he") ? "rtl" : "ltr",
      title: v.versionTitle ?? "",
      source: v.versionSource ?? null,
      license: licenseLabel(v.license),
      licenseUrl: licenseUrl(v.license),
      free,
      text: free ? flatten(v.text).map((s) => s.trim()).filter(Boolean) : null,
      isSource: v.isSource ?? language === "he",
    };
  });
  return { ref, heRef: typeof body.heRef === "string" ? body.heRef : null, versions };
}

export class SefariaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SefariaError";
  }
}

/** Fetch one passage. `fetchImpl` is the consented ledger fetch in the app, a stub in tests. */
export async function fetchPassage(ref: SourceRef, fetchImpl: typeof fetch): Promise<Passage> {
  const res = await fetchImpl(apiUrl(ref), { headers: { Accept: "application/json" } });
  if (!res.ok) throw new SefariaError(`Sefaria answered ${res.status}`, res.status);
  return parseTextsResponse(ref, await res.json());
}
