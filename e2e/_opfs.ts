import { test, type Page } from "@playwright/test";

/**
 * OPFS in the e2e browsers (plan 0.5, W4.12).
 *
 * Playwright's WebKit on Linux has no usable Origin Private File System:
 * `navigator.storage.getDirectory()` fails there with "UnknownError: The
 * operation failed for an unknown transient reason" (Playwright's own
 * tests/library/capabilities.spec.ts expects exactly that on WebKit and no
 * error on Chromium and Firefox). So a test that seeds or reads the vault
 * through OPFS cannot run on WebKit — an engine capability, not a flake.
 *
 * A vault test seeds first and hands the result to `vaultOrSkip`:
 *
 *   vaultOrSkip(await opfsWritable(page), browserName);
 *
 * It skips only on the engines in OPFS_GAP. On Chromium and Firefox a vault
 * that cannot be written is a broken test setup or a regression, so the test
 * fails there instead of skipping quietly (before W4.12 every engine skipped).
 */

/** Engines where Playwright's OPFS is known to be missing. */
export const OPFS_GAP: ReadonlySet<string> = new Set(["webkit"]);

/** Go on when the vault could be written; skip on an OPFS_GAP engine; fail anywhere else. */
export function vaultOrSkip(written: boolean, browserName: string): void {
  if (written) return;
  // skip-reason: Playwright's Linux WebKit has no OPFS (getDirectory() throws UnknownError) | task: 0.5 | until: 2027-05-12
  test.skip(OPFS_GAP.has(browserName), `Playwright's ${browserName} has no OPFS, so there is no vault here; this flow runs on chromium and firefox`);
  throw new Error(`the vault could not be written on ${browserName}, where OPFS works: a regression or a broken seed, not a reason to skip`);
}

/**
 * Can this engine write OPFS files at all here? False when OPFS is missing
 * (Linux WebKit) or refuses writes in the ephemeral test context. Without
 * createWritable (Safari) it probes the worker-only sync access handle the
 * app falls back to.
 */
export async function opfsWritable(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle("__probe", { create: true });
      const h = fh as unknown as { createWritable?: () => Promise<{ write(d: string): Promise<void>; close(): Promise<void> }> };
      if (typeof h.createWritable === "function") {
        const w = await h.createWritable();
        await w.write("x");
        await w.close();
      } else {
        const src =
          "self.onmessage=async()=>{try{const r=await navigator.storage.getDirectory();const f=await r.getFileHandle('__probe',{create:true});const a=await f.createSyncAccessHandle();a.write(new Uint8Array([120]),{at:0});a.flush();a.close();postMessage(true)}catch(e){postMessage(false)}}";
        const ok = await new Promise<boolean>((res) => {
          const w = new Worker(URL.createObjectURL(new Blob([src], { type: "application/javascript" })));
          w.onmessage = (e) => res(e.data === true);
          w.onerror = () => res(false);
          w.postMessage(0);
          setTimeout(() => res(false), 5000);
        });
        if (!ok) return false;
      }
      await root.removeEntry("__probe");
      return true;
    } catch {
      return false;
    }
  });
}
