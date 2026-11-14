/**
 * SOURCES.md and LICENSE of each set, generated from defs.mjs, the
 * manifest's part status and the provenance each data file records. The
 * licence gate (scripts/lib/licenses.mjs checkDatasets) reads the "Licence"
 * column of the parts table in SOURCES.md.
 *
 * Neither file names the version or freeze date (the manifest holds them),
 * so regenerating them before a freeze is stable.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { partWaitsFor, readJson } from "../lib/golden.mjs";
import { LICENSE_REFS, SPDX, SRC, VERIFIED_ON } from "./defs.mjs";
import { fetchText, rawUrl } from "./fetch.mjs";

const licenceIds = (expr) => expr.split(/\s+AND\s+|\s+OR\s+|[;,]\s*/).map((s) => s.trim()).filter(Boolean);

function partSource(p) {
  const s = p.src ? SRC[p.src] : null;
  if (s?.repo) return `${s.name} — [${s.repo}](https://github.com/${s.repo}/tree/${s.commit})${s.tag ? ` ${s.tag}` : ""} @ \`${s.commit.slice(0, 7)}\``;
  if (s?.npm) return `${s.name} — [npm ${s.npm}@${s.version}](https://www.npmjs.com/package/${s.npm}/v/${s.version}), tarball sha256 \`${s.tgz.slice(0, 12)}…\``;
  if (s) return s.name;
  return p.url ? `${p.source} — ${p.url}` : (p.source ?? "");
}

function partEvidence(p) {
  if (p.evidence) return p.evidence;
  if (p.src && SRC[p.src]?.evidence) return `${SRC[p.src].evidence} (checked ${VERIFIED_ON})`;
  if (p.status === "owner-pending") return "The owner's own material, given under CC0 1.0 in CONSENT.md inside the encrypted bundle (15.11).";
  return "Written for this set by the golden-set agent; dedicated under CC0 1.0.";
}

const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderSources(def, dir) {
  const m = readJson(join(dir, "manifest.json"));
  const parts = def.parts.map((p) => ({ ...p, ...m.parts.find((x) => x.id === p.id) }));
  const out = [];
  out.push(`# ${def.id} — sources and licences`, "");
  out.push(`${def.title}, for plan task ${def.capability}. Metric: ${def.metric}. Target: ${def.target} items.`, "");
  out.push(`Only the dev split is in this folder (dev/, or ids and sha256 in selection/ for local-only parts). The test split is held out: CI rebuilds it from the same pools with the secret GOLDEN_SEED and records only its sha256 in manifest.json (see eval/golden/README.md).`, "");
  out.push(`Dev canary (see eval/golden/README.md): \`${m.canary}\``, "");
  out.push("## Parts", "");
  out.push("| Part | Items | Dev (committed) | Test (CI only) | Status | Source | Licence | Licence verified |", "|---|---|---|---|---|---|---|---|");
  for (const p of parts) {
    const status = p.review === "pending" ? `${p.status}, review pending` : p.status;
    const verified = p.evidence ? "at run time, by the workflow" : p.status === "owner-pending" ? "owner consent (15.11)" : p.src ? `${SRC[p.src]?.verifiedOn ?? VERIFIED_ON}, source's own LICENSE / README` : "own work";
    const dev = p.status === "local-only" ? `${p.dev} (ids only)` : String(p.dev);
    out.push(`| ${p.id} | ${p.items} | ${dev} | ${p.test} | ${status} | ${cell(partSource(p))} | ${p.license} | ${verified} |`);
  }
  out.push("");
  for (const p of parts) {
    out.push(`## ${p.id}`, "");
    out.push(p.about, "");
    out.push(`- **Licence:** ${p.license}. ${partEvidence(p)}`);
    const s = p.src ? SRC[p.src] : null;
    if (s?.cite) out.push(`- **Attribution:** ${s.cite}`);
    const dataFile = (p.devFiles ?? []).find((f) => f.endsWith(".json")) ?? (p.devSelection || null);
    if (dataFile && existsSync(join(dir, dataFile))) {
      const src = readJson(join(dir, dataFile)).source;
      if (src?.files) {
        out.push(`- **Upstream files (sha256):**`);
        for (const [f, sha] of Object.entries(src.files)) out.push(`  - \`${f}\` — \`${sha}\``);
      }
      if (src?.sampling) out.push(`- **Sampling:** ${src.sampling}`);
      out.push(`- **Dev data:** \`${dataFile}\`${(p.devFiles ?? []).length > 1 ? ` and ${p.devFiles.length - 1} asset file(s)` : ""}`);
    }
    const waits = partWaitsFor(p, m.test);
    if (waits) out.push(`- **Waiting for:** ${waits}`);
    if (p.spec) out.push(`- **The owner provides:** ${p.spec}`);
    out.push("");
  }
  if (def.notes?.length) {
    out.push("## Notes", "");
    for (const n of def.notes) out.push(`- ${n}`);
    out.push("");
  }
  return out.join("\n");
}

/** The licence texts and notices for every licence any part of the set uses. */
export function renderLicense(def, cache) {
  const byLicence = new Map();
  for (const p of def.parts) for (const id of licenceIds(p.license)) byLicence.set(id, [...(byLicence.get(id) ?? []), p]);
  const out = [`Licences of eval/golden/${def.id}`, "", "This folder holds data under the licences below. SOURCES.md names the licence, source and attribution of each part, and every data file repeats its part's licence in its `license` field. Local-only parts are never stored here; their licence is listed for completeness.", ""];
  for (const [id, parts] of byLicence) {
    const names = parts.map((p) => `${p.id}${p.status === "local-only" ? " (local-only)" : ""}`).join(", ");
    out.push("=".repeat(72), `${id} — part(s): ${names}`, "=".repeat(72), "");
    for (const p of parts) {
      const s = p.src ? SRC[p.src] : null;
      if (s?.cite) out.push(`${p.id}: ${s.cite}. Changes: items were sampled and reformatted as JSON for this set.`);
      else if (p.status === "owner-pending") out.push(`${p.id}: the owner's own material, given under CC0 1.0 (CONSENT.md in the owner's encrypted bundle; never stored in this folder).`);
      else if (!p.src && !p.url) out.push(`${p.id}: written for this set; dedicated to the public domain under CC0 1.0.`);
      else out.push(`${p.id}: ${p.source}${p.url ? `, ${p.url}` : ""}. Changes: items were sampled and reformatted as JSON for this set.`);
    }
    out.push("");
    out.push(licenceText(id, parts, cache).trim(), "");
  }
  return out.join("\n");
}

function licenceText(id, parts, cache) {
  if (SPDX.texts[id]) return fetchText(cache, rawUrl(SPDX.repo, SPDX.commit, `text/${id}.txt`), { sha: SPDX.texts[id], name: `spdx-${id}.txt` });
  if (LICENSE_REFS[id]) return `${LICENSE_REFS[id].title}\n\n${LICENSE_REFS[id].text}`;
  if (id === "MIT") return parts.map((p) => mitNotice(p, cache)).join("\n\n");
  throw new Error(`no licence text for ${id}`);
}

/** The MIT notice of each upstream, verbatim from its own files. */
function mitNotice(p, cache) {
  if (p.src === "faker") {
    const s = SRC.faker;
    return `--- ${p.id}: Faker (data read from src/locales/he) ---\n\n${fetchText(cache, rawUrl(s.repo, s.commit, "LICENSE"), { name: "faker-LICENSE" })}`;
  }
  if (p.src === "bipia") {
    const s = SRC.bipia;
    const lic = fetchText(cache, rawUrl(s.repo, s.commit, "LICENSE"), { name: "bipia-LICENSE" });
    const notice = fetchText(cache, rawUrl(s.repo, s.commit, "NOTICE.md"), { name: "bipia-NOTICE.md" });
    const evals = notice.slice(notice.indexOf("Invoices data in Openai Evals"));
    const mit = evals.slice(evals.indexOf("MIT License"), evals.indexOf("NOTE:"));
    return `--- ${p.id}: BIPIA attacks and task (microsoft/BIPIA LICENSE) ---\n\n${lic.replace(/^ {4}/gm, "")}\n\n--- ${p.id}: EmailQA contexts, "Invoices data in Openai Evals" (from microsoft/BIPIA NOTICE.md) ---\n\n${mit.trim()}`;
  }
  return `--- ${p.id}: ${p.source} ---\n\nMIT License, as declared by the dataset card (${p.url}). The card names no copyright line of its own; the workflow records the card's licence field in data/${p.id}.json (source.cardLicense).\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
}

export function writeDocs(def, dir, cache) {
  writeFileSync(join(dir, "SOURCES.md"), renderSources(def, dir) + "\n");
  writeFileSync(join(dir, "LICENSE"), renderLicense(def, cache) + "\n");
}

export const hasFile = (dir, f) => existsSync(join(dir, f)) && readFileSync(join(dir, f)).length > 0;
