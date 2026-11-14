// Live agent eval (`npm run eval:agents`): the app's Vitest setup, but only
// the *.eval.ts files, one at a time, with no per-test timeout cap.
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vite.config";

const config = mergeConfig(base, defineConfig({ test: { testTimeout: 60 * 60 * 1000, fileParallelism: false } }));
// mergeConfig concatenates arrays; the eval replaces the include list.
config.test = { ...config.test, include: ["src/agents/eval/**/*.eval.ts"] };
export default config;
