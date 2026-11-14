/**
 * The only classroom module the startup code imports, and only on use (plan
 * W5.21): one hop to the lazily loaded panel, as ../ui/launch.ts does for sync.
 */

export function openClassroom(): Promise<void> {
  return import("./open").then((m) => m.openClassroom());
}

/** Boot with a `#class=…` fragment: join once the app has rendered its vault. */
export async function classLinkReturn(ready: Promise<unknown>): Promise<void> {
  const hash = location.hash;
  try {
    await ready;
    await (await import("./open")).joinFromHash(hash);
  } catch (err) {
    const { log } = await import("../../../lib/logger");
    log.warn("classroom link failed", err);
  }
}
