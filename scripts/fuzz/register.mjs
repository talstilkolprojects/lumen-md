/**
 * Lets Node load the app's TypeScript modules for the fuzzer: Vite-style
 * imports without an extension ("./shared") resolve to ./shared.ts or
 * ./shared/index.ts, and JSON imports get their import attribute. Used with
 * Node's type stripping (scripts/fuzz/run.mjs adds both flags).
 */
import { register } from "node:module";

register(new URL("./hooks.mjs", import.meta.url));
