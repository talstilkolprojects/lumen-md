/**
 * Golden eval harness for the bidi set (plan 9.7): accuracy of the line
 * direction the editors give each line (src/lib/bidiDirection.ts), against
 * the set's expected rtl / ltr / neutral. Run by run-evals.mjs on the
 * held-out test split; returns numbers only.
 *
 * The app module is TypeScript: it is transpiled with the repo's own
 * `typescript` into a temporary directory and imported from there.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const LIB = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "lib");

async function loadDirection() {
  const dir = mkdtempSync(join(tmpdir(), "lumen-bidi-eval-"));
  try {
    for (const name of ["bidiDirection", "bidiStrong.generated"]) {
      const src = readFileSync(join(LIB, `${name}.ts`), "utf8").replace(/from "\.\/bidiStrong\.generated"/, 'from "./bidiStrong.generated.mjs"');
      const { outputText } = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
      writeFileSync(join(dir, `${name}.mjs`), outputText);
    }
    return await import(pathToFileURL(join(dir, "bidiDirection.mjs")).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function score({ items }) {
  const { markdownLineDirection } = await loadDirection();
  let right = 0;
  const byDir = {};
  for (const it of items) {
    const got = markdownLineDirection(it.line) ?? "neutral";
    const ok = got === it.dir;
    if (ok) right++;
    byDir[it.dir] ??= { n: 0, right: 0 };
    byDir[it.dir].n++;
    if (ok) byDir[it.dir].right++;
  }
  const out = { accuracy: items.length ? right / items.length : 0, items: items.length };
  for (const [d, v] of Object.entries(byDir)) out[`accuracy_${d}`] = v.right / v.n;
  return out;
}
