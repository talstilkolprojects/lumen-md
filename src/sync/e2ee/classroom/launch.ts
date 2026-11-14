/**
 * The only classroom module the startup code imports, and only on use (plan
 * W5.21): one hop to the lazily loaded panel, as ../ui/launch.ts does for sync.
 */

// Plan W11.S1: the classroom seals work with the sync's cryptography, so it waits for the sync.e2ee flag too.
export function openClassroom(): Promise<void> {
  return import("../ui/unaudited").then((g) => g.whenE2eeOn(() => import("./open").then((m) => m.openClassroom())));
}

/** Boot with a `#class=…` fragment: join once the app has rendered its vault. */
export async function classLinkReturn(ready: Promise<unknown>): Promise<void> {
  const hash = location.hash;
  try {
    await ready;
    await (await import("../ui/unaudited")).whenE2eeOn(async () => (await import("./open")).joinFromHash(hash));
  } catch (err) {
    const { log } = await import("../../../lib/logger");
    log.warn("classroom link failed", err);
  }
}
