#!/usr/bin/env node
/**
 * Plan W6.38: writes src/__tests__/fixtures/real-corpus/manifest.json — every
 * file of the import/paste corpus with its format, ORIGIN, source, licence and
 * sha256. `--check` fails when a file and the manifest disagree.
 *
 * Origin (plan W10.B5, audit W6.38). Despite the folder name, 7 of the 8
 * formats are ours:
 *   ours-synthetic       written by our scripts (model.py → render.py,
 *                        notion_wa.py) in the shape the real app writes;
 *   converted-from-ours  our documents run through a real program
 *                        (LibreOffice: .docx, .pdf, its clipboard HTML);
 *   third-party          files someone else's software wrote (Evernote ENEX
 *                        from yarle's test data).
 * A converter scored on our own imitation of a format measures itself, so
 * realCorpus.test.ts reports the two groups separately. Real files from
 * contributors are plan 10.O.
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
  "word-docx": { dir: "docx", ext: /\.docx$/, origin: "converted-from-ours", licence: CC0, source: `${LO}: our source HTML (render.py) saved as MS Word 2007 XML — not a file Word wrote` },
  "word-paste": { dir: "paste-word", ext: /\.html$/, origin: "ours-synthetic", licence: CC0, source: "our imitation of Word 2016+ clipboard HTML (MsoNormal, mso-list, conditional comments, VML images), rendered by render.py — not captured from Word" },
  "gdocs-paste": { dir: "paste-gdocs", ext: /\.html$/, origin: "ours-synthetic", licence: CC0, source: "our imitation of Google Docs clipboard HTML (docs-internal-guid wrapper, styled spans, aria-level lists, Docs tables), rendered by render.py — not captured from Google Docs" },
  "libreoffice-paste": { dir: "paste-libreoffice", ext: /\.html$/, origin: "converted-from-ours", licence: CC0, source: `${LO}: our .docx saved as HTML (StarWriter), Writer's own clipboard HTML` },
  "pdf-hebrew": { dir: "pdf", ext: /\.pdf$/, origin: "converted-from-ours", licence: CC0, source: `${LO}: our .docx exported to PDF; pdf-copy/ holds the text pdf.js 6.2 and poppler copy out of it` },
  notion: { dir: "notion", ext: /\.zip$/, origin: "ours-synthetic", licence: CC0, source: "our imitation of a Notion export (Markdown & CSV with _all.csv, and HTML), written by notion_wa.py in Notion's file layout — not exported from Notion" },
  evernote: { dir: "evernote", ext: /\.enex$/, origin: "third-party", licence: "MIT (yarle, Copyright (c) 2018 Akos Balasko; LICENSE-yarle.txt)", source: "github.com/akosbalasko/yarle test/data @ 1ab3ef4a7: ENEX exported by Evernote Mac/Windows" },
  whatsapp: { dir: "whatsapp", ext: /\.txt$/, origin: "ours-synthetic", licence: CC0, source: "our imitation of WhatsApp 'Export chat' text, Android and iPhone, he/en/ar/de locales, written by notion_wa.py — not exported from WhatsApp" },
};
const sha = (p) => createHash("sha256").update(readFileSync(join(DIR, p))).digest("hex");

export function build() {
  const formats = {};
  for (const [name, f] of Object.entries(FORMATS)) {
    formats[name] = {
      origin: f.origin,
      licence: f.licence,
      source: f.source,
      files: readdirSync(join(DIR, f.dir)).filter((x) => f.ext.test(x)).sort().map((x) => ({ path: `${f.dir}/${x}`, sha256: sha(`${f.dir}/${x}`), origin: f.origin, licence: f.licence, source: f.source })),
    };
  }
  const derived = ["model.json", "whatsapp/expected.json", ...["pdfjs", "poppler"].flatMap((v) => readdirSync(join(DIR, "pdf-copy", v)).sort().map((x) => `pdf-copy/${v}/${x}`))].map((p) => ({ path: p, sha256: sha(p) }));
  return { $comment: "Plan W6.38: the import/paste corpus. Not a real-world corpus (plan W10.B5): 7 of the 8 formats are ours (origin ours-synthetic: written by render.py / notion_wa.py; converted-from-ours: our documents through LibreOffice). Only evernote is third-party (yarle's test data). Regenerate with node scripts/real-corpus/manifest.mjs.", formats, derived };
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
