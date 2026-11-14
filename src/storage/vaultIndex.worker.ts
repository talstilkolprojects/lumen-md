/// <reference lib="webworker" />
/**
 * The vault index worker (plan 8.4): holds the search / backlinks index
 * (./vaultIndexCore.ts) off the main thread. The main thread reads the
 * notes through the VaultBackend and sends their text here; queries come
 * back as plain results. See ./vaultIndexProtocol.ts.
 */
import { VaultIndex } from "./vaultIndexCore";
import { handleIndexRequest } from "./vaultIndexLocal";
import type { IndexRequest } from "./vaultIndexProtocol";

const index = new VaultIndex();

self.onmessage = (e: MessageEvent<IndexRequest>) => {
  (self as unknown as Worker).postMessage(handleIndexRequest(index, e.data));
};
