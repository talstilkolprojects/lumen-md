/**
 * What Lumen may keep from an open source (plans W7.5, W7.6, W7.7, W7.24).
 *
 * Every result from an open source carries one of these rights, and the
 * rights decide how it is stored in a note:
 *
 *   public-domain, cc0          → a full copy; credit is a courtesy.
 *   cc-by, cc-by-sa             → a full copy with the credit the licence asks for.
 *   section-6                   → a full copy: Copyright Act 2007 §6 — no
 *                                 copyright in laws, regulations, Knesset
 *                                 records (דברי הכנסת) and judicial decisions.
 *   cbs-licence                 → a full copy of the numbers with the CBS
 *                                 attribution (licence 2.1, commercial use allowed).
 *   gov-open                    → data.gov.il: a full copy with its credit
 *                                 (site, dataset, update date — the site's FAQ).
 *   link-only                   → only a link (and a title): anything else —
 *                                 non-commercial, no-derivatives, copyrighted,
 *                                 attachments to Knesset records (opinions,
 *                                 presentations) and unknown terms.
 *
 * Sefaria (W5.1) keeps its own per-version licence classes in
 * sources/sefaria/license.ts; `rightsOfSefariaLicense` maps them here.
 */

export type Rights = "public-domain" | "cc0" | "cc-by" | "cc-by-sa" | "section-6" | "cbs-licence" | "gov-open" | "link-only";

export const ALL_RIGHTS: readonly Rights[] = ["public-domain", "cc0", "cc-by", "cc-by-sa", "section-6", "cbs-licence", "gov-open", "link-only"];

/** May the content itself be copied into the vault? */
export function mayCopy(rights: Rights): boolean {
  return rights !== "link-only";
}

/** Where each right is explained (shown with the badge). */
export const RIGHTS_URL: Record<Rights, string | null> = {
  "public-domain": "https://en.wikipedia.org/wiki/Public_domain",
  cc0: "https://creativecommons.org/publicdomain/zero/1.0/",
  "cc-by": "https://creativecommons.org/licenses/by/4.0/",
  "cc-by-sa": "https://creativecommons.org/licenses/by-sa/4.0/",
  "section-6": "https://sherut.haifa.ac.il/extprojects/scill/images/pdf/Copyright_Law_2007_Hebrew.pdf",
  "cbs-licence": "https://www.cbs.gov.il/he/Pages/%D7%A8%D7%99%D7%A9%D7%99%D7%95%D7%9F-%D7%A9%D7%99%D7%9E%D7%95%D7%A9.aspx",
  "gov-open": "https://data.gov.il",
  "link-only": null,
};

/** Sefaria's per-version licence (W5.1) as a right. */
export function rightsOfSefariaLicense(license: string | null | undefined): Rights {
  const k = (license ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (k === "public domain" || k === "pd") return "public-domain";
  if (/^cc ?0/.test(k)) return "cc0";
  if (k === "cc-by" || k === "cc by") return "cc-by";
  if (k === "cc-by-sa" || k === "cc by-sa") return "cc-by-sa";
  return "link-only";
}

/** Text kept only when the rights allow it: link-only content is dropped here, before it can reach a note. */
export function keepIfAllowed<T>(rights: Rights, content: T): T | null {
  return mayCopy(rights) ? content : null;
}
