/**
 * webR's browser ES module, loaded from where webR is served (plan W1.34):
 * the user's download in the webr runtime cache (the service worker serves
 * it under /webr/), or a deployment's own copy (`npm run webr:local`). It
 * is not bundled: webR is GPL-3.0 and Lumen's build ships none of it.
 * A module of its own so tests can replace it.
 */
import type * as WebRModule from "webr";
import { webrBaseUrl } from "./webrPaths";

export function loadWebRModule(): Promise<typeof WebRModule> {
  return import(/* @vite-ignore */ `${webrBaseUrl()}webr.js`) as Promise<typeof WebRModule>;
}
