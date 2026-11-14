// Vitest config for mutation testing (plan 0.11, .github/workflows/weekly-health.yml):
// only the tests of the mutated modules, so each mutant runs in seconds.
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  root,
  resolve: { alias: { "@": `${root}src` } },
  test: {
    environment: "jsdom",
    globals: true,
    css: false,
    setupFiles: ["src/__tests__/setup.ts"],
    include: ["src/__tests__/hebrew.test.ts", "src/__tests__/cspEndpoints.test.ts"],
  },
});
