/**
 * Module hooks so a Node script can import the app's TypeScript modules
 * with type stripping: Vite-style imports without an extension resolve to
 * `.ts` or `/index.ts`. Use: node --experimental-transform-types --import ./scripts/lib/ts-register.mjs …
 */
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
