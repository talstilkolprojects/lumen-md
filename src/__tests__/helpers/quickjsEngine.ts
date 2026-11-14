/**
 * The plugin test kit's `engine` hook, served by the app's own QuickJS sandbox
 * (src/plugins/runtime/sandbox.ts): the plugin's main.js runs as a module in
 * real QuickJS, with the app's method table and its default-deny grants, and
 * every call it is allowed to make goes to the test kit's mocks (plan W6.35).
 *
 * The sandbox settles host calls on the host's event loop, a turn after the
 * plugin made them, so `idle()` waits until no call is in flight before the
 * test looks at the mocks. A fatal error (an uncaught error in a handler, a
 * limit) fails the event that caused it, as an exception does in the vm kit.
 */
import type { PluginEngine } from "../../../packages/create-lumen-plugin/template/tools/testkit.mjs";
import { createSandbox } from "../../plugins/runtime/sandbox";
import { grantsFrom } from "../../plugins/runtime/capabilities";
import { parseManifest } from "../../plugins/runtime/manifest";

/** How long to wait for the plugin's calls to settle before giving up, ms. */
const IDLE_TIMEOUT_MS = 5000;

export const quickjsEngine: PluginEngine = async ({ manifest, code, grants, call, log }) => {
  let inFlight = 0;
  const fatals: string[] = [];
  const sandbox = await createSandbox({
    manifest: parseManifest(manifest),
    code,
    grants: grantsFrom(grants),
    host: {
      call: async (method, args) => {
        inFlight++;
        try {
          return await call(method, args);
        } finally {
          inFlight--;
        }
      },
      log,
      fatal: (error) => void fatals.push(error),
    },
  });
  /** Two quiet turns of the event loop in a row with nothing in flight: the plugin has nothing left to do. */
  const idle = async () => {
    const started = Date.now();
    let quiet = 0;
    while (quiet < 2) {
      await new Promise((r) => setTimeout(r, 0));
      quiet = inFlight === 0 ? quiet + 1 : 0;
      if (Date.now() - started > IDLE_TIMEOUT_MS) throw new Error(`plugin ${String(manifest.id)}: calls still in flight after ${IDLE_TIMEOUT_MS} ms`);
    }
  };
  await idle();
  if (fatals.length) throw new Error(fatals[0]);
  return {
    denied: sandbox.denied,
    async dispatch(name, payload) {
      const seen = fatals.length;
      await sandbox.dispatch(name, payload);
      await idle();
      if (fatals.length > seen) throw new Error(fatals[seen]);
    },
    dispose: () => sandbox.dispose(),
  };
};
