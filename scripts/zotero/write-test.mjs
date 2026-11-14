#!/usr/bin/env node
/**
 * W8.4 — the real Zotero write check for W6.47's "Send to Zotero", for an
 * owner session (api.zotero.org isn't reachable from the agents' sandbox):
 *
 *   ZOTERO_KEY=… ZOTERO_USER=… ZOTERO_PARENT=<PDF attachment key in a TEST library> \
 *     npx tsx scripts/zotero/write-test.mjs [--cleanup]
 *   npx tsx scripts/zotero/write-test.mjs --fake     # the same steps against an in-memory library
 *
 * Steps: send three Hebrew/English highlights through the app's own sender
 * (src/citations/zoteroAnnotations.ts sendAnnotations), read the attachment's
 * annotation children back, compare every field (text, comment, colour, page
 * label, sort index, position), then send again with the returned sent file
 * and check that nothing new was created. --cleanup deletes what it created.
 * Exit 0 only when the notes come back identical and the resend made 0 duplicates.
 */
import { createPdfAnnotation } from "../../src/pdf/annotations.ts";
import { sendAnnotations, toZoteroAnnotation, zoteroCall } from "../../src/citations/zoteroAnnotations.ts";

const TEXT = "פרוטוקול ישיבה\nהספרייה העירונית נפתחה מחדש אחרי שיפוץ של שנתיים.\nThe library reopened (ISBN 978-965).\n";
const PAGE_H = 842;
const FIELDS = ["annotationType", "annotationText", "annotationComment", "annotationColor", "annotationPageLabel", "annotationSortIndex", "annotationPosition"];

export function sampleAnnotations(run) {
  const mk = (n, page, start, end, note) =>
    createPdfAnnotation({ id: `${run.slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, "0")}`, source: "lumen-write-test.pdf", page, text: TEXT, start, end, rect: { left: 72, top: 100 + 20 * n, width: 300, height: 14 }, note, now: new Date() });
  return [mk(1, 1, 15, 41, "הערה ראשונה"), mk(2, 1, 42, 60, ""), mk(3, 2, 61, 96, "English note, with a comma")];
}

/** The fields Zotero must give back unchanged, per highlight text. */
export function compareBack(sentItems, readBack) {
  const problems = [];
  for (const s of sentItems) {
    const got = readBack.filter((r) => r.annotationText === s.annotationText && r.annotationSortIndex === s.annotationSortIndex);
    if (got.length !== 1) {
      problems.push(`${JSON.stringify(s.annotationText.slice(0, 30))}: found ${got.length} times`);
      continue;
    }
    for (const f of FIELDS) if (String(got[0][f] ?? "") !== String(s[f] ?? "")) problems.push(`${f} of ${JSON.stringify(s.annotationText.slice(0, 30))}: sent ${JSON.stringify(s[f])}, got ${JSON.stringify(got[0][f])}`);
  }
  return problems;
}

/** An in-memory Zotero user library (as in zoteroAnnotations.test.ts): keys, write tokens, items, children. */
export function fakeLibrary(user, parent) {
  const items = new Map();
  const tokens = new Set();
  let n = 0;
  const res = (status, json) => ({ status, headers: new Headers(), body: JSON.stringify(json) });
  const call = async (method, path, body, headers = {}) => {
    if (method === "GET" && path === "/keys/current") return res(200, { userID: user, access: { user: { library: true, write: true } } });
    if (method === "GET" && path.startsWith(`/users/${user}/items/${parent}/children`)) return res(200, [...items.values()].map((data) => ({ key: data.key, data })));
    if (method === "POST" && path === `/users/${user}/items`) {
      const tok = headers["Zotero-Write-Token"];
      if (tokens.has(tok)) return res(412, "used");
      tokens.add(tok);
      const out = { successful: {}, success: {}, unchanged: {}, failed: {} };
      body.forEach((it, i) => {
        const key = `K${String(++n).padStart(7, "0")}`;
        items.set(key, { ...it, key });
        out.successful[i] = { key };
        out.success[i] = key;
      });
      return res(200, out);
    }
    return res(404, "not found");
  };
  return { call, items };
}

async function main() {
  const fake = process.argv.includes("--fake");
  const user = fake ? 1 : Number(process.env.ZOTERO_USER);
  const parent = fake ? "PARENT01" : process.env.ZOTERO_PARENT;
  const key = process.env.ZOTERO_KEY;
  if (!fake && (!key || !user || !parent)) {
    console.error("usage: ZOTERO_KEY=… ZOTERO_USER=… ZOTERO_PARENT=… npx tsx scripts/zotero/write-test.mjs [--cleanup] | --fake");
    process.exit(2);
  }
  const lib = fake ? fakeLibrary(user, parent) : null;
  // privacy-ledger: an owner's test command (not the app): api.zotero.org with the owner's own key, a test library.
  const call = lib ? lib.call : zoteroCall(key, (u, init) => fetch(u, init));
  const run = crypto.randomUUID();
  const anns = sampleAnnotations(run);
  const heights = [PAGE_H, PAGE_H];
  const first = await sendAnnotations({ call, userID: user, parentItem: parent, annotations: anns, pageHeights: heights, sentFile: { v: 1, sent: {} }, consent: true });
  const sentItems = anns.map((a) => toZoteroAnnotation(a, parent, PAGE_H)).filter(Boolean);
  const children = async () => JSON.parse((await call("GET", `/users/${user}/items/${parent}/children?itemType=annotation&format=json&limit=100`)).body).map((x) => x.data ?? x);
  const back = (await children()).filter((r) => sentItems.some((s) => s.annotationText === r.annotationText));
  const problems = compareBack(sentItems, back);
  const before = (await children()).length;
  const second = await sendAnnotations({ call, userID: user, parentItem: parent, annotations: anns, pageHeights: heights, sentFile: first.sentFile, consent: true });
  const after = (await children()).length;
  const dups = after - before;
  console.log(`zotero write-test${fake ? " (fake library)" : ""}: sent ${first.sent}, failed ${first.failed.length}; read back ${back.length}/${sentItems.length}, field mismatches ${problems.length}; resend sent ${second.sent}, skipped ${second.skipped}, new items ${dups}`);
  for (const p of problems) console.log(`  ${p}`);
  if (!fake && process.argv.includes("--cleanup")) {
    const keys = Object.values(first.sentFile.sent).map((s) => s.key);
    const ver = (await call("GET", `/users/${user}/items/${parent}`)).headers.get("Last-Modified-Version");
    const r = await fetch(`https://api.zotero.org/users/${user}/items?itemKey=${keys.join(",")}`, { method: "DELETE", headers: { "Zotero-API-Key": key, "Zotero-API-Version": "3", "If-Unmodified-Since-Version": String(ver) } });
    console.log(`  cleanup: DELETE ${keys.length} items → ${r.status}`);
  }
  const ok = first.sent === sentItems.length && !first.failed.length && back.length === sentItems.length && !problems.length && second.sent === 0 && dups === 0;
  console.log(ok ? "PASS: the notes come back identical, 0 duplicates on resend" : "FAIL");
  process.exit(ok ? 0 : 1);
}

if (process.argv[1]?.endsWith("write-test.mjs")) await main();
