// Would `cargo check --locked` accept this Cargo.lock for Cargo.toml? (plan W4.23)
// Checks: every [dependencies]/[target.*.dependencies]/[build-dependencies] name is in the root
// package's lock entry, the entry has no extra direct deps, every path crate is a package,
// and every dependency reference resolves to exactly one package.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from './lockdiff.mjs';
const dir = process.argv[2];
const toml = fs.readFileSync(path.join(dir, 'Cargo.toml'), 'utf8');
const root = toml.match(/^\[package\][\s\S]*?^name = "(.+)"/m)[1];
const want = new Set();
let sect = '';
for (const line of toml.split('\n')) {
  const h = line.match(/^\[(.+)\]\s*$/); if (h) { sect = h[1]; continue; }
  if (/(^|\.)(build-)?dependencies$/.test(sect) && !/dev-dependencies/.test(sect)) { const m = line.match(/^([A-Za-z0-9_-]+)\s*=/); if (m) want.add(m[1]); }
}
// cargo's TOML parser refuses a key twice in one table and a [table] header twice
// ("error: duplicate key") before it resolves anything; rustc against stubs never sees it.
const dup = [];
{
  const headers = new Map(); const keys = new Map(); let table = '';
  toml.split('\n').forEach((line, i) => {
    const h = line.match(/^\[([^\[\]]+)\]\s*(#.*)?$/);
    if (h) { table = h[1].trim(); if (headers.has(table)) dup.push(`Cargo.toml:${i + 1}: table [${table}] again (first at line ${headers.get(table)})`); else headers.set(table, i + 1); return; }
    if (/^\[\[/.test(line)) { table = ''; return; }
    const k = line.match(/^([A-Za-z0-9_-]+|"[^"]+")\s*=/);
    if (k && table) { const id = `${table}\u0000${k[1].replace(/"/g, '')}`; if (keys.has(id)) dup.push(`Cargo.toml:${i + 1}: ${k[1]} again in [${table}] (first at line ${keys.get(id)})`); else keys.set(id, i + 1); }
  });
}
if (dup.length) { console.log('FAIL Cargo.toml: duplicate key (cargo refuses the manifest)'); dup.forEach(e => console.log('     ' + e)); process.exit(1); }
const lock = parse(path.join(dir, 'Cargo.lock'));
const pkg = lock.pk.find(p => p.name === root);
const have = new Set(pkg.deps.map(d => d.split(' ')[0]));
const errs = [];
for (const w of want) if (!have.has(w)) errs.push(`Cargo.lock: ${root} lacks dependency ${w}`);
for (const h of have) if (!want.has(h)) errs.push(`Cargo.lock: ${root} lists ${h}, which Cargo.toml no longer has`);
const names = new Map(); for (const p of lock.pk) names.set(p.name, (names.get(p.name) || []).concat(p.version));
for (const p of lock.pk) for (const d of p.deps) { const [n, v] = d.split(' '); const vs = names.get(n); if (!vs || (v && !vs.includes(v)) || (!v && vs.length !== 1)) errs.push(`Cargo.lock: ${p.name} -> unresolved ${d}`); }
if (errs.length) { console.log('FAIL Cargo.lock vs Cargo.toml (cargo --locked would refuse)'); errs.forEach(e => console.log('     ' + e)); process.exit(1); }
console.log(`ok   Cargo.lock matches Cargo.toml (${want.size} direct deps, ${lock.pk.length} packages)`);
