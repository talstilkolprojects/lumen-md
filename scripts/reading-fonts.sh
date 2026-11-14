#!/usr/bin/env bash
# Rebuild public/fonts/reading/ (plan W3.5) from the upstream OFL sources.
#
# Needs: git, fonttools (pip install fonttools brotli).
# Sources: github.com/google/fonts (ofl/notosanshebrew, notoserifhebrew,
# assistant, davidlibre) and github.com/antijingoist/opendyslexic.
# The Hebrew faces are subset to Hebrew (every point and cantillation mark,
# presentation forms), Latin-1 and punctuation, with every OpenType layout
# feature kept (nikud is placed by GPOS mark positioning). OpenDyslexic has
# a Reserved Font Name, so its WOFF2 files are copied unchanged.
#
#   scripts/reading-fonts.sh <work dir>
set -euo pipefail
work=${1:?work dir}
out=$(cd "$(dirname "$0")/.." && pwd)/public/fonts/reading
mkdir -p "$work" "$out"
cd "$work"
[ -d gf ] || git clone -q --depth 1 --filter=blob:none --sparse https://github.com/google/fonts gf
(cd gf && git sparse-checkout set ofl/notosanshebrew ofl/notoserifhebrew ofl/assistant ofl/davidlibre)
[ -d od ] || git clone -q --depth 1 https://github.com/antijingoist/opendyslexic od

UNI="U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0590-05FF,U+200C-200F,U+2010-2027,U+2030-203A,U+20AA,U+20AC,U+2122,U+25CC,U+FB1D-FB4F"
subset() { # <in.ttf> <out.woff2> [instancer limits…]
  local in=$1 dst=$2 tmp
  shift 2
  tmp=$(mktemp --suffix=.ttf)
  if [ $# -gt 0 ]; then fonttools varLib.instancer "$in" "$@" -o "$tmp" -q; else cp "$in" "$tmp"; fi
  pyftsubset "$tmp" --unicodes="$UNI" --layout-features='*' --name-IDs='*' --name-legacy --name-languages='*' \
    --notdef-outline --no-hinting --flavor=woff2 --output-file="$dst"
  rm -f "$tmp"
}
subset "gf/ofl/notosanshebrew/NotoSansHebrew[wdth,wght].ttf" "$out/noto-sans-hebrew.woff2" wdth=100 wght=400:700
subset "gf/ofl/notoserifhebrew/NotoSerifHebrew[wdth,wght].ttf" "$out/noto-serif-hebrew.woff2" wdth=100 wght=400:700
subset "gf/ofl/assistant/Assistant[wght].ttf" "$out/assistant.woff2" wght=400:700
subset gf/ofl/davidlibre/DavidLibre-Regular.ttf "$out/david-libre-400.woff2"
subset gf/ofl/davidlibre/DavidLibre-Bold.ttf "$out/david-libre-700.woff2"
cp od/compiled/OpenDyslexic-Regular.woff2 "$out/opendyslexic-400.woff2"
cp od/compiled/OpenDyslexic-Bold.woff2 "$out/opendyslexic-700.woff2"
for f in notosanshebrew:noto-sans-hebrew notoserifhebrew:noto-serif-hebrew assistant:assistant davidlibre:david-libre; do
  cp "gf/ofl/${f%%:*}/OFL.txt" "$out/OFL-${f##*:}.txt"
done
cp od/OFL.txt "$out/OFL-opendyslexic.txt"
ls -l "$out"
echo "Update the byte counts in src/reading/fonts.ts (src/__tests__/readingFonts.test.ts checks them)."
