import fs from 'node:fs';
export function parse(file) {
  const t = fs.readFileSync(file, 'utf8');
  const pk = t.split(/\n\[\[package\]\]\n/).slice(1).map(b => {
    const o = { deps: [] };
    o.name = b.match(/^name = "(.+)"/m)[1]; o.version = b.match(/^version = "(.+)"/m)[1];
    const d = b.match(/dependencies = \[\n([\s\S]*?)\]/); if (d) o.deps = [...d[1].matchAll(/"(.+)"/g)].map(m => m[1]);
    o.raw = b.replace(/\n+$/, ''); return o;
  });
  return { head: t.split(/\n\[\[package\]\]\n/)[0], pk };
}
if (process.argv[1]?.endsWith("lockdiff.mjs")) {
  const a = parse(process.argv[2]), b = parse(process.argv[3]);
  const key = p => p.name + ' ' + p.version;
  const A = new Map(a.pk.map(p => [key(p), p])), B = new Map(b.pk.map(p => [key(p), p]));
  console.log('only in A:', [...A.keys()].filter(k => !B.has(k)).join(', '));
  console.log('only in B:', [...B.keys()].filter(k => !A.has(k)).join(', '));
  for (const [k, p] of A) if (B.has(k) && JSON.stringify(p.deps) !== JSON.stringify(B.get(k).deps)) {
    const q = B.get(k); console.log('deps differ', k, '| A-only:', p.deps.filter(x => !q.deps.includes(x)).join(','), '| B-only:', q.deps.filter(x => !p.deps.includes(x)).join(','));
  }
}
