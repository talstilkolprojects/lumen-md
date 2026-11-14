/**
 * Holds every write of one object (the manifest) until `n` reads of it
 * happened, so two devices both start a sync round from the same version N
 * — the race of plan 3.4, run against any SyncProvider (plan 3.5).
 */
import type { PutCondition, SyncProvider } from "../../sync/e2ee/provider";

export interface GatedProvider extends SyncProvider {
  /** The object name to gate (set once the manifest name is known). */
  manifest?: string;
  readonly inner: SyncProvider;
}

export function gatedProvider(inner: SyncProvider, n: number): GatedProvider {
  let reads = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const p: GatedProvider = {
    id: `gated:${inner.id}`,
    inner,
    manifest: undefined,
    get: async (name: string) => {
      const o = await inner.get(name);
      if (name === p.manifest && ++reads >= n) open();
      return o;
    },
    put: async (name: string, data: Uint8Array, cond?: PutCondition) => {
      if (name === p.manifest) await gate;
      return inner.put(name, data, cond);
    },
    delete: (name: string) => inner.delete(name),
    list: () => inner.list(),
  };
  return p;
}
