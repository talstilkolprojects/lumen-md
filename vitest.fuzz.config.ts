// The nightly redaction fuzz (`npm run fuzz:redaction`, plan W8.8): the app's
// Vitest setup, but only tests/fuzz/**/*.fuzz.ts, one file at a time, with no
// per-test timeout cap. The main suite never runs these; it replays the
// regressions they save (src/__tests__/redactionFuzzRegressions.test.ts).
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vite.config";

const config = mergeConfig(base, defineConfig({ test: { testTimeout: 6 * 60 * 60 * 1000, fileParallelism: false } }));
// mergeConfig concatenates arrays; the fuzz replaces the include list.
config.test = { ...config.test, include: ["tests/fuzz/**/*.fuzz.ts"] };
export default config;
