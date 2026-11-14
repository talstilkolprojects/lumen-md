/**
 * The app's own modules, for Playwright specs that drive them from inside
 * the page (W4.2). A spec used to `import("/src/…")` there, which only the
 * dev server answers; the production build that the e2e gate serves has no
 * /src/. Here the same modules load through the bundle's own chunks, so a
 * spec gets the very instances the app runs (one store, one vault).
 *
 * Installed as `window.__lumenTest` on the dev server and in a build made
 * with VITE_E2E=1 (scripts/vercel-build.mjs sets it for preview builds,
 * whose e2e gate needs it). A production build has neither: main.tsx's
 * check is a constant there, and the bundler drops this file.
 */
const MODULES = {
  "storage/workspace": () => import("../storage/workspace"),
  "storage/vault": () => import("../storage/vault/index"),
  "storage/vault/location": () => import("../storage/vault/location"),
  "storage/vault/encrypted/session": () => import("../storage/vault/encrypted/session"),
  "sync/git": () => import("../sync/git"),
  "store/gitPullDocs": () => import("../store/gitPullDocs"),
  "store/useStore": () => import("../store/useStore"),
  "ai/ocr": () => import("../ai/ocr"),
};

export type E2eModuleName = keyof typeof MODULES;
export type E2eModule<K extends E2eModuleName> = Awaited<ReturnType<(typeof MODULES)[K]>>;

export interface LumenTestHooks {
  /** One of the app's modules, as the running app has it. */
  load<K extends E2eModuleName>(name: K): Promise<E2eModule<K>>;
  /** The names `load` knows. */
  modules: E2eModuleName[];
}

export function installE2eHooks(target: { __lumenTest?: LumenTestHooks } = window as unknown as { __lumenTest?: LumenTestHooks }): void {
  target.__lumenTest = {
    load<K extends E2eModuleName>(name: K) {
      return MODULES[name]() as unknown as Promise<E2eModule<K>>;
    },
    modules: Object.keys(MODULES) as E2eModuleName[],
  };
}
