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

// Requests run one after another: a snapshot restore finishes before the
// upserts sent after it (W2.22: some requests are asynchronous now).
let queue: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent<IndexRequest>) => {
  const req = e.data;
  queue = queue
    .then(async () => {
      // W6.36: work a request hands back runs after its answer, before the next request.
      const later: Array<() => Promise<void>> = [];
      (self as unknown as Worker).postMessage(await handleIndexRequest(index, req, (w) => later.push(w)));
      for (const w of later) await w().catch(() => {});
    })
    .catch(() => {});
};
