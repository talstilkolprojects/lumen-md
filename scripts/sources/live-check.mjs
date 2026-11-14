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
};

const rowsOf = (j) => (Array.isArray(j?.value) ? j.value : Array.isArray(j?.d) ? j.d : Array.isArray(j?.d?.results) ? j.d.results : []);

async function get(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const cors = res.headers.get("access-control-allow-origin");
  return { res, cors, json: res.ok ? await res.json() : null };
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
      const rows = rowsOf(r.json);
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
