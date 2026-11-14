/**
 * Percy snapshots from Playwright without a new dependency (plan W7.25).
 *
 * What @percy/playwright does, in the few calls it needs: `percy exec` runs a
 * local server (PERCY_SERVER_ADDRESS, http://localhost:5338 by default); a
 * snapshot fetches its DOM serializer (/percy/dom.js), serializes the page
 * (the DOM, CSS and the canvas as images) and posts it to /percy/snapshot.
 * Percy then renders that DOM in real Chrome, Firefox, Safari and Edge
 * (the project's browser settings) and compares it with main's baseline.
 * Outside `percy exec` the server isn't there and snapshots are skipped.
 */
import type { Page } from "@playwright/test";

export const PERCY_SERVER = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.PERCY_SERVER_ADDRESS ?? "http://localhost:5338";
export const CLIENT_INFO = "lumen-md-visual/1.0";

export interface PercyOptions {
  widths?: number[];
  minHeight?: number;
  /** CSS added for this snapshot only (stable.css is in .percy.yml for all). */
  percyCSS?: string;
  /** Run the page's JavaScript when Percy renders it (off: the DOM as captured). */
  enableJavaScript?: boolean;
}

type Fetch = typeof fetch;

/** Is `percy exec` running? Cached per server address. */
const enabled = new Map<string, Promise<boolean>>();
export function percyEnabled(server = PERCY_SERVER, f: Fetch = fetch): Promise<boolean> {
  let p = enabled.get(server);
  if (!p) {
    // privacy-ledger: a test helper (not the app): the Percy CLI on this machine only.
    p = f(`${server}/percy/healthcheck`)
      .then((r) => r.ok)
      .catch(() => false);
    enabled.set(server, p);
  }
  return p;
}

export interface SnapshotPayload {
  name: string;
  url: string;
  domSnapshot: unknown;
  clientInfo: string;
  environmentInfo: string;
  widths?: number[];
  minHeight?: number;
  percyCSS?: string;
  enableJavaScript?: boolean;
}

export function snapshotPayload(name: string, url: string, domSnapshot: unknown, opts: PercyOptions, environmentInfo: string): SnapshotPayload {
  return { name, url, domSnapshot, clientInfo: CLIENT_INFO, environmentInfo, ...opts };
}

/** Snapshot the page as it is now. Returns false (and does nothing) outside `percy exec`. */
export async function percySnapshot(page: Page, name: string, opts: PercyOptions = {}, f: Fetch = fetch, server = PERCY_SERVER): Promise<boolean> {
  if (!(await percyEnabled(server, f))) return false;
  // privacy-ledger: a test helper (not the app): the Percy CLI on this machine only.
  const dom = await (await f(`${server}/percy/dom.js`)).text();
  await page.evaluate(dom);
  const domSnapshot = await page.evaluate((o) => (window as unknown as { PercyDOM: { serialize: (x: unknown) => unknown } }).PercyDOM.serialize(o), { enableJavaScript: opts.enableJavaScript ?? false });
  const body = snapshotPayload(name, page.url(), domSnapshot, opts, `playwright/${page.context().browser()?.version() ?? "?"}`);
  // privacy-ledger: a test helper (not the app): the Percy CLI on this machine only.
  const res = await f(`${server}/percy/snapshot`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`percy snapshot "${name}": ${res.status} ${await res.text()}`);
  return true;
}
