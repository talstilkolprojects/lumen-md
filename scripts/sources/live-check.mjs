#!/usr/bin/env node
/**
 * Owner check for the open sources (plans W7.5–W7.7): ask each live service
 * the questions the app asks, and compare the answers with the shapes the
 * recorded fixtures assume. Run it on a machine with network access:
 *
 *   node scripts/sources/live-check.mjs            # every source
 *   node scripts/sources/live-check.mjs knesset    # one source
 *
 * It prints one line per check and exits 1 when a check fails. It sends
 * nothing but the fixed test queries below.
 */

const checks = {
  knesset: [
    {
      name: "KNS_IsraelLaw (V4) by name",
      url: `https://knesset.gov.il/OdataV4/ParliamentInfo/KNS_IsraelLaw?$filter=${encodeURIComponent("contains(Name,'הפרטיות')")}&$top=5`,
      fallback: `https://knesset.gov.il/Odata/ParliamentInfo.svc/KNS_IsraelLaw?$filter=${encodeURIComponent("substringof('הפרטיות',Name)")}&$top=5&$format=json`,
      fields: ["IsraelLawID", "Name", "IsBasicLaw", "PublicationDate", "LawValidityDesc", "LastUpdatedDate"],
      expect: (rows) => rows.some((r) => String(r.Name).includes("הגנת הפרטיות")),
    },
    {
      name: "KNS_Bill by name",
      url: `https://knesset.gov.il/OdataV4/ParliamentInfo/KNS_Bill?$filter=${encodeURIComponent("contains(Name,'הפרטיות')")}&$top=3`,
      fallback: `https://knesset.gov.il/Odata/ParliamentInfo.svc/KNS_Bill?$filter=${encodeURIComponent("substringof('הפרטיות',Name)")}&$top=3&$format=json`,
      fields: ["BillID", "Name", "KnessetNum", "SubTypeDesc", "PublicationDate"],
    },
    {
      name: "KNS_DocumentCommitteeSession",
      url: "https://knesset.gov.il/OdataV4/ParliamentInfo/KNS_DocumentCommitteeSession?$top=3",
      fallback: "https://knesset.gov.il/Odata/ParliamentInfo.svc/KNS_DocumentCommitteeSession?$top=3&$format=json",
      fields: ["DocumentCommitteeSessionID", "CommitteeSessionID", "GroupTypeDesc", "ApplicationDesc", "FilePath"],
    },
  ],
  datagov: [
    {
      name: "CKAN package_search",
      url: "https://data.gov.il/api/3/action/package_search?q=" + encodeURIComponent("תאונות דרכים") + "&rows=3",
      rows: (j) => j?.result?.results ?? [],
      fields: ["name", "title", "organization", "metadata_modified", "resources"],
    },
    {
      name: "CBS series 120010 (CPI)",
      url: "https://apis.cbs.gov.il/series/data/list?id=120010&format=json&download=false",
      rows: (j) => j?.DataSet?.Series ?? [],
      fields: ["id", "obs"],
    },
  ],
  benyehuda: [
    {
      name: "public_domain_dump catalogue",
      url: "https://raw.githubusercontent.com/projectbenyehuda/public_domain_dump/master/pseudocatalogue.csv",
      text: true,
      fields: ["ID", "path", "title", "authors", "translators", "genre"],
      expect: (rows) => rows.some((r) => r.ID === "4387" && r.path === "/p89/m4387"),
    },
  ],
};

const rowsOf = (j) => (Array.isArray(j?.value) ? j.value : Array.isArray(j?.d) ? j.d : Array.isArray(j?.d?.results) ? j.d.results : []);

/** A small CSV reader for the catalogue's first lines (quoted fields with commas). */
function csvRows(text) {
  const lines = text.split("\n").slice(0, 2000).filter(Boolean);
  const split = (l) => (l.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? []).map((f) => f.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'));
  const head = split(lines[0] ?? "");
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i], v])));
}

async function get(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const cors = res.headers.get("access-control-allow-origin");
  if (!res.ok) return { res, cors, json: null };
  const body = await res.text();
  try {
    return { res, cors, json: JSON.parse(body), body };
  } catch {
    return { res, cors, json: null, body };
  }
}

let failed = 0;
const want = process.argv.slice(2);
for (const [source, list] of Object.entries(checks)) {
  if (want.length && !want.includes(source)) continue;
  for (const c of list) {
    try {
      let r = await get(c.url);
      let used = "v4";
      if (!r.res.ok && c.fallback) {
        r = await get(c.fallback);
        used = "fallback";
      }
      if (!r.res.ok) throw new Error(`HTTP ${r.res.status}`);
      const rows = c.text ? csvRows(r.body ?? "") : c.rows ? c.rows(r.json) : rowsOf(r.json);
      const missing = c.fields.filter((f) => rows.length && !(f in rows[0]));
      const ok = rows.length > 0 && !missing.length && (!c.expect || c.expect(rows));
      if (!ok) failed++;
      console.log(`${ok ? "ok  " : "FAIL"} ${source}: ${c.name} [${used}] rows=${rows.length}${missing.length ? ` missing=${missing.join(",")}` : ""} cors=${r.cors ?? "none"}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${source}: ${c.name}: ${e.message}`);
    }
  }
}
process.exit(failed ? 1 : 0);
