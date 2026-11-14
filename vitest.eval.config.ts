// Live agent eval (`npm run eval:agents`): the app's Vitest setup, but only
// the *.eval.ts files, one at a time, with no per-test timeout cap.
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vite.config";

// reproducible.ts pins Ollama's speculative decoding off and records the Ollama version (plan W7.15).
const config = mergeConfig(base, defineConfig({ test: { testTimeout: 60 * 60 * 1000, fileParallelism: false, setupFiles: ["src/agents/eval/reproducible.ts"] } }));
// mergeConfig concatenates arrays; the eval replaces the include list.
config.test = { ...config.test, include: ["src/agents/eval/**/*.eval.ts"] };
export default config;
