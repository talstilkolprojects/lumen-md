/** Module hooks for scripts/fuzz/register.mjs. */
import { existsSync, statSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(spec, ctx, next) {
  if ((spec.startsWith("./") || spec.startsWith("../")) && ctx.parentURL?.startsWith("file:")) {
    const base = resolvePath(dirname(fileURLToPath(ctx.parentURL)), spec);
    for (const c of [base, `${base}.ts`, `${base}/index.ts`]) {
      if (existsSync(c) && statSync(c).isFile()) return { url: pathToFileURL(c).href, shortCircuit: true };
    }
  }
  return next(spec, ctx);
}

export async function load(url, ctx, next) {
  if (url.endsWith(".json")) return next(url, { ...ctx, importAttributes: { type: "json" } });
  return next(url, ctx);
}
