/**
 * ESLint (plan 0.4). Flat config: typescript-eslint, react-hooks, jsx-a11y
 * and Lumen's own rules, on the app sources (src/).
 *
 * Baseline: violations that existed when this was introduced are recorded
 * in eslint-suppressions.json (ESLint's bulk suppressions), so only NEW
 * ones fail `npm run lint` and CI. A file may not gain violations of a rule
 * it already had either: the counts are per file and rule.
 *   npm run lint              check (CI)
 *   npm run lint:prune        drop suppressions that are fixed (CI fails until you do)
 * Never run `--suppress-all` to make a new violation pass; fix it, or
 * disable the rule on that line with a reason.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import globals from "globals";
import emptyCatchWhy from "./eslint-rules/empty-catch-why.js";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "public/**",
      "src-tauri/**",
      "**/*.d.ts",
    ],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended, jsxA11y.flatConfigs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser },
      parserOptions: {
        // Type information for no-floating-promises.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      lumen: { rules: { "empty-catch-why": emptyCatchWhy } },
    },
    rules: {
      // 0.4.1
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],
      // 0.4.2: an empty catch says why (`// why: …`). Replaces no-empty for catch blocks.
      "lumen/empty-catch-why": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
      // TypeScript already checks these.
      "no-undef": "off",
      "no-redeclare": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  {
    // Tests: same rules, plus the test runner's globals.
    files: ["src/**/__tests__/**/*.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // errorBoundary.test.ts and .tsx share a base name, so the TypeScript
    // program only holds the .ts one and this file has no type information
    // (tsc never checks it either). Lint it without the typed rules.
    files: ["src/__tests__/errorBoundary.test.tsx"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { parserOptions: { projectService: false, project: null } },
  },
);
