/**
 * Side-effect module: a worker imports this first, so its requests reach the
 * privacy ledger (plan 2.4, see workerLedger.ts). ES modules evaluate in
 * import order, so a library imported after this sees the wrapped `fetch`.
 */
import { installWorkerLedger } from "./workerLedger";

installWorkerLedger(self as unknown as Parameters<typeof installWorkerLedger>[0]);
