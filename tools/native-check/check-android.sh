#!/bin/bash
# Compile android/app/src/main/java offline (plan W4.23): javac against stub
# android/androidx/Capacitor/org.json classes (java-stubs/) and an R class generated
# from res/; then check that every @string/@xml/@layout/@drawable/@mipmap/@style
# reference in res/ and the manifest exists. Usage: check-android.sh <repo>
set -u
D=$(cd "$(dirname "$0")" && pwd); A=$1/android/app/src/main; W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
status=0
node - "$A" "$W" <<'JS'
const fs = require('fs'), path = require('path');
const [A, W] = process.argv.slice(2);
const res = path.join(A, 'res'); const ids = new Set(), types = {};
const add = (t, n) => (types[t] ??= new Set()).add(n.replace(/\./g, '_'));
for (const d of fs.readdirSync(res)) {
  const base = d.split('-')[0];
  for (const f of fs.readdirSync(path.join(res, d))) {
    const p = path.join(res, d, f); const name = f.replace(/\.(xml|png|webp|9\.png|jpg)$/, '').replace(/\.9$/, '');
    if (base !== 'values') add(base, name);
    if (f.endsWith('.xml')) {
      const x = fs.readFileSync(p, 'utf8');
      for (const m of x.matchAll(/@\+id\/([A-Za-z0-9_]+)/g)) ids.add(m[1]);
      if (base === 'values') for (const m of x.matchAll(/<(string|style|color|dimen|bool|integer)\s+name="([^"]+)"/g)) add(m[1], m[2]);
    }
  }
}
types.id = ids;
let n = 0; const cls = Object.entries(types).map(([t, s]) => `  public static final class ${t} {\n${[...s].map(k => `    public static final int ${k} = ${++n};`).join('\n')}\n  }`).join('\n');
fs.mkdirSync(path.join(W, 'gen/com/lumen/editor'), { recursive: true });
fs.writeFileSync(path.join(W, 'gen/com/lumen/editor/R.java'), `package com.lumen.editor;\npublic final class R {\n${cls}\n}\n`);
// references
const errs = []; const files = [path.join(A, 'AndroidManifest.xml')];
for (const d of fs.readdirSync(res)) for (const f of fs.readdirSync(path.join(res, d))) if (f.endsWith('.xml')) files.push(path.join(res, d, f));
for (const f of files) for (const m of fs.readFileSync(f, 'utf8').matchAll(/"@(string|xml|layout|drawable|mipmap|style|color|dimen)\/([A-Za-z0-9_.]+)"/g)) {
  if (!types[m[1]]?.has(m[2].replace(/\./g, '_'))) errs.push(`${path.relative(A, f)}: @${m[1]}/${m[2]} not defined`);
}
// every string in values/ also in values-iw/ (Hebrew) when that folder exists
const strings = d => { const p = path.join(res, d, 'strings.xml'); return fs.existsSync(p) ? new Set([...fs.readFileSync(p, 'utf8').matchAll(/<string\s+name="([^"]+)"/g)].map(m => m[1])) : null; };
const en = strings('values'), he = strings('values-iw') || strings('values-he');
const noHe = en && he ? [...en].filter(k => !he.has(k)) : [];
if (errs.length) { console.log('FAIL resources'); errs.forEach(e => console.log('     ' + e)); process.exit(1); }
console.log(`ok   resources: ${files.length} xml files, every @ reference defined` + (noHe.length ? `; not in Hebrew (fall back to English): ${noHe.join(', ')}` : ''));
JS
[ $? -eq 0 ] || status=1
mkdir -p "$W/cls"
if javac -Xlint:all -Werror -d "$W/cls" -sourcepath "$D/java-stubs" "$W/gen/com/lumen/editor/R.java" $(find "$A/java" -name '*.java') $(ls "$1"/mobile/android/*.java 2>/dev/null) 2>"$W/javac.err"; then
  echo "ok   javac -Xlint:all -Werror: $(ls "$1"/mobile/android/*.java 2>/dev/null | wc -l) mobile/android + $(find "$A/java" -name '*.java' | wc -l) app files ($(find "$A/java" -name '*.java' -printf '%f ' ))"
else
  echo "FAIL javac"; grep -v "Picked up JAVA_TOOL_OPTIONS" "$W/javac.err"; status=1
fi
exit $status
