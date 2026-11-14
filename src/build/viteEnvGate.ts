/**
 * Plan W4.4 / 15.18: a build fails when a VITE_* variable that is not on
 * security/vite-env-allowlist.json is set — in the environment (Vercel,
 * CI, a shell) or in an .env file Vite would load.
 *
 * Vite puts VITE_* values into the public bundle, and before #243 it put
 * every one of them there. A secret set as VITE_* is therefore public the
 * moment a build runs; this stops the build before that happens. Only
 * names are reported, never values.
 *
 * Build tooling: imported by vite.config.ts and tests, never by the app.
 */
import { loadEnv, type Plugin } from "vite";
import { checkViteEnv, formatViteEnvError, loadAllowlist } from "../../scripts/lib/viteEnvAllowlist.mjs";

/** The VITE_* names of `env` that may not be set (empty when the build may go on). */
export function disallowedViteEnv(env: Record<string, string | undefined>): string[] {
  return checkViteEnv(env, loadAllowlist()).disallowed;
}

export function viteEnvGatePlugin(): Plugin {
  return {
    name: "lumen-vite-env-gate",
    apply: "build",
    configResolved(config) {
      const envDir = typeof config.envDir === "string" ? config.envDir : config.root;
      // loadEnv merges the .env files with process.env, VITE_* only.
      const env = { ...loadEnv(config.mode, envDir, "VITE_") };
      for (const [k, v] of Object.entries(process.env)) if (k.startsWith("VITE_")) env[k] = v ?? "";
      const disallowed = disallowedViteEnv(env);
      if (disallowed.length) throw new Error(formatViteEnvError(disallowed));
    },
  };
}
