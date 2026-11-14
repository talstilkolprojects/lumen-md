/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** Current `lumen-runtime-*` cache names (vite.config.ts `define`). */
declare const __LUMEN_RUNTIME_CACHES__: string[];

/** The app's version, from package.json (vite.config.ts `define`, plan 14.6). */
declare const __LUMEN_VERSION__: string;

/** This version's "What's new" notes in every language (vite.config.ts, plan 14.6). */
declare module "virtual:lumen-whats-new" {
  const notes: import("../scripts/lib/whats-new.mjs").WhatsNew | null;
  export default notes;
}
/** True in a build made with VITE_E2E=1: install window.__lumenTest (vite.config.ts `define`). */
declare const __LUMEN_E2E__: boolean;
