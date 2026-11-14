#!/usr/bin/env bash
# Plan W6.38: rebuild the real import/paste corpus (src/__tests__/fixtures/real-corpus).
# Needs python3 with Pillow, LibreOffice (soffice), poppler (pdftotext) and pdfjs-dist.
# The Evernote files are copied from yarle's test/data (MIT); see manifest.mjs.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$HERE/../.."
OUT="$ROOT/src/__tests__/fixtures/real-corpus"; TMP="$(mktemp -d)"
python3 "$HERE/model.py" "$TMP/model.json"
python3 "$HERE/render.py" "$TMP/model.json" "$TMP"
soffice --headless --infilter="HTML (StarWriter)" --convert-to 'docx:MS Word 2007 XML' --outdir "$OUT/docx" "$TMP"/src/doc*.html
soffice --headless --convert-to pdf:writer_pdf_Export --outdir "$OUT/pdf" "$OUT"/docx/*.docx
soffice --headless --convert-to 'html:HTML (StarWriter):EmbedImages' --outdir "$OUT/paste-libreoffice" "$OUT"/docx/*.docx
cp "$TMP"/gdocs/*.html "$OUT/paste-gdocs/"; cp "$TMP"/word/*.html "$OUT/paste-word/"; cp "$TMP/model.json" "$OUT/model.json"
python3 "$HERE/notion_wa.py" "$OUT/model.json" "$TMP" && cp "$TMP"/notion/*.zip "$OUT/notion/" && cp "$TMP"/whatsapp/* "$OUT/whatsapp/"
node "$HERE/pdftext.mjs" "$OUT/pdf" "$OUT/pdf-copy"
node "$HERE/manifest.mjs"
