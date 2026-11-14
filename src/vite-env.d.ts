/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** Current `lumen-runtime-*` cache names (vite.config.ts `define`). */
declare const __LUMEN_RUNTIME_CACHES__: string[];
/** True in a build made with VITE_E2E=1: install window.__lumenTest (vite.config.ts `define`). */
declare const __LUMEN_E2E__: boolean;
