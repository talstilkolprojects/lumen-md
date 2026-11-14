// W6.38: what a person copies out of each PDF: pdf.js (Firefox's viewer) text layer order, and poppler (Evince, Okular) via pdftotext.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
const pdfjs = await import(process.env.PDFJS ?? "pdfjs-dist/legacy/build/pdf.mjs");
const [dir, out] = process.argv.slice(2);
mkdirSync(`${out}/pdfjs`, { recursive: true }); mkdirSync(`${out}/poppler`, { recursive: true });
for (const f of readdirSync(dir).filter((x) => x.endsWith(".pdf")).sort()) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(`${dir}/${f}`)), useSystemFonts: false, disableFontFace: true }).promise;
  let text = "";
  for (let p = 1; p <= doc.numPages; p++) {
    const c = await (await doc.getPage(p)).getTextContent();
    for (const it of c.items) { text += it.str; if (it.hasEOL) text += "\n"; }
    text += "\n";
  }
  writeFileSync(`${out}/pdfjs/${f.replace(/\.pdf$/, ".txt")}`, text.replace(/\n{3,}/g, "\n\n"));
  writeFileSync(`${out}/poppler/${f.replace(/\.pdf$/, ".txt")}`, execFileSync("pdftotext", ["-nopgbrk", `${dir}/${f}`, "-"]).toString());
}
