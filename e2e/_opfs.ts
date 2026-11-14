import type { Page } from "@playwright/test";

/**
 * OPFS in the e2e browsers (plan 0.5).
 *
 * Playwright's WebKit on Linux has no Origin Private File System at all:
 * `navigator.storage.getDirectory` is undefined there, so any test that
 * seeds or reads the vault through OPFS fails on WebKit every time — not a
 * flake, an engine capability. A vault test calls this first and skips with
 * the reason when it is false:
 *
 *   test.skip(!(await opfsWritable(page)), "OPFS writes are unavailable in this engine's test context");
 */

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
