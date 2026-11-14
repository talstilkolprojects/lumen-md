/**
 * Which Sefaria texts Lumen may copy into a note (plan W5.1).
 *
 * Sefaria publishes a licence per version of a text (per language), in the
 * `license` field of its texts API (developers.sefaria.org, "Copyright and
 * Data Use"; the values and their links are Sefaria's own, from
 * static/js/sefaria/sefaria.js and the version editor's list):
 *   Public Domain, CC0, CC-BY, CC-BY-SA       → free: copied, with attribution;
 *   CC-BY-NC, CC-BY-NC-SA, CC-BY-NC-ND,        → not free: a link only — never
 *   "Copyright…", no licence noted               stored in the vault or cached.
 *
 * Non-commercial licences are treated as not free: Lumen does not know what
 * a note will be used for, and a note travels (sync, publish, export).
 * "No noted license" means Sefaria has not verified the copyright, so it is
 * not free either.
 */

export type LicenseClass = "free" | "link-only";

const FREE = new Map<string, string>([
  ["public domain", "https://en.wikipedia.org/wiki/Public_domain"],
  ["pd", "https://en.wikipedia.org/wiki/Public_domain"],
  ["cc0", "https://creativecommons.org/publicdomain/zero/1.0/"],
  ["cc-by", "https://creativecommons.org/licenses/by/3.0/"],
  ["cc-by-sa", "https://creativecommons.org/licenses/by-sa/3.0/"],
]);

const LINK_ONLY_URLS = new Map<string, string>([
  ["cc-by-nc", "https://creativecommons.org/licenses/by-nc/4.0/"],
  ["cc-by-nc-sa", "https://creativecommons.org/licenses/by-nc-sa/4.0/"],
  ["cc-by-nc-nd", "https://creativecommons.org/licenses/by-nc-nd/4.0/"],
]);

const key = (license: string | null | undefined) => (license ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/^cc ?0.*$/, "cc0").replace(/^cc ?by/, "cc-by");

/** Free (may be copied into the vault) or link-only. Unknown or missing licences are link-only. */
export function licenseClass(license: string | null | undefined): LicenseClass {
  return FREE.has(key(license)) ? "free" : "link-only";
}

export function isFreeLicense(license: string | null | undefined): boolean {
  return licenseClass(license) === "free";
}

/** The licence's deed, when there is one. */
export function licenseUrl(license: string | null | undefined): string | null {
  const k = key(license);
  return FREE.get(k) ?? LINK_ONLY_URLS.get(k) ?? null;
}

/** How the licence is written on the note: Sefaria's own value, or "no licence noted". */
export function licenseLabel(license: string | null | undefined): string {
  const l = (license ?? "").trim();
  return l || "unknown";
}
