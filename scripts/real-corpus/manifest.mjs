#!/usr/bin/env node
/**
 * Plan W6.38: writes src/__tests__/fixtures/real-corpus/manifest.json — every
 * file of the real import/paste corpus with its format, source, licence and
 * sha256. `--check` fails when a file and the manifest disagree.
 *
 * How the corpus is made (scripts/real-corpus/, see build.sh):
 *   model.py      30 documents written for the corpus (CC0 1.0), seeded
 *   render.py     → the HTML LibreOffice reads, and the Google Docs and Word
 *                   clipboard payloads of each document
 *   LibreOffice   → .docx (MS Word 2007 XML), → .pdf, → its own clipboard HTML
 *   pdftext.mjs   → the text a person copies out of each PDF (pdf.js, poppler)
 *   notion_wa.py  → 30 Notion exports and 30 WhatsApp chats
 *   evernote/     35 ENEX files from yarle's test data (MIT, see LICENSE-yarle.txt)
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = join(ROOT, "src/__tests__/fixtures/real-corpus");
const CC0 = "CC0-1.0 (written for this corpus)";
const LO = "LibreOffice 24.2.7.2 (Linux)";
const FORMATS = {
  "word-docx": { dir: "docx", ext: /\.docx$/, licence: CC0, source: `${LO}: the source HTML saved as MS Word 2007 XML` },
  "word-paste": { dir: "paste-word", ext: /\.html$/, licence: CC0, source: "Word 2016+ clipboard HTML (MsoNormal, mso-list, conditional comments, VML images), rendered by render.py" },
  "gdocs-paste": { dir: "paste-gdocs", ext: /\.html$/, licence: CC0, source: "Google Docs clipboard HTML (docs-internal-guid wrapper, styled spans, aria-level lists, Docs tables), rendered by render.py" },
  "libreoffice-paste": { dir: "paste-libreoffice", ext: /\.html$/, licence: CC0, source: `${LO}: the .docx saved as HTML (StarWriter), Writer's own clipboard HTML` },
  "pdf-hebrew": { dir: "pdf", ext: /\.pdf$/, licence: CC0, source: `${LO}: the .docx exported to PDF; pdf-copy/ holds the text pdf.js 6.2 and poppler copy out of it` },
  notion: { dir: "notion", ext: /\.zip$/, licence: CC0, source: "Notion export (Markdown & CSV with _all.csv, and HTML), written by notion_wa.py in Notion's file layout" },
  evernote: { dir: "evernote", ext: /\.enex$/, licence: "MIT (yarle, Copyright (c) 2018 Akos Balasko; LICENSE-yarle.txt)", source: "github.com/akosbalasko/yarle test/data @ 1ab3ef4a7: ENEX exported by Evernote Mac/Windows" },
  whatsapp: { dir: "whatsapp", ext: /\.txt$/, licence: CC0, source: "WhatsApp 'Export chat' text, Android and iPhone, he/en/ar/de locales, written by notion_wa.py" },
};
const sha = (p) => createHash("sha256").update(readFileSync(join(DIR, p))).digest("hex");

export function build() {
  const formats = {};
  for (const [name, f] of Object.entries(FORMATS)) {
    formats[name] = {
      licence: f.licence,
      source: f.source,
      files: readdirSync(join(DIR, f.dir)).filter((x) => f.ext.test(x)).sort().map((x) => ({ path: `${f.dir}/${x}`, sha256: sha(`${f.dir}/${x}`), licence: f.licence, source: f.source })),
    };
  }
  const derived = ["model.json", "whatsapp/expected.json", ...["pdfjs", "poppler"].flatMap((v) => readdirSync(join(DIR, "pdf-copy", v)).sort().map((x) => `pdf-copy/${v}/${x}`))].map((p) => ({ path: p, sha256: sha(p) }));
  return { $comment: "Plan W6.38: the real import/paste corpus. Regenerate with node scripts/real-corpus/manifest.mjs.", formats, derived };
}

const out = join(DIR, "manifest.json");
const next = JSON.stringify(build(), null, 1) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(out, "utf8") !== next) {
    console.error("✖ real-corpus manifest is out of date: node scripts/real-corpus/manifest.mjs");
    process.exit(1);
  }
  console.error("✓ real-corpus manifest matches every file");
} else {
  writeFileSync(out, next);
  const m = JSON.parse(next);
  console.error(`wrote ${out}: ${Object.entries(m.formats).map(([k, v]) => `${k} ${v.files.length}`).join(", ")}`);
}
