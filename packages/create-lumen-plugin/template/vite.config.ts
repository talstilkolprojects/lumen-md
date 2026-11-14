import { defineConfig } from "vite";

// Build the plugin as a single ESM bundle that Lumen's plugin loader
// can consume via `import(url)`. React is left external — the host
// already ships React 18 and we just borrow its instance.
export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: () => "__PLUGIN_NAME__.js",
    },
    rolldownOptions: {
      external: ["react", "react/jsx-runtime"],
    },
    sourcemap: true,
    emptyOutDir: true,
  },
});
