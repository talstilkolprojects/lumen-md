/**
 * OPFS write fallback for engines without `FileSystemFileHandle.createWritable`
 * on the main thread (Safari before 26, Playwright WebKit). There the only
 * way to write an OPFS file is a sync access handle, which exists only inside
 * a dedicated worker — so this module keeps one small blob: worker and sends
 * it (path, bytes) pairs to write. Part of the OPFS vault backend (./opfs.ts),
 * which calls it when a file handle has no `createWritable`.
 */

const WORKER_SOURCE = `
self.onmessage = async function (e) {
  var msg = e.data || {};
  try {
    var dir = await navigator.storage.getDirectory();
    var parts = msg.parts || [];
    for (var i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i], { create: true });
    var file = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    var handle = await file.createSyncAccessHandle();
    try {
      handle.truncate(0);
      handle.write(new Uint8Array(msg.bytes), { at: 0 });
      handle.flush();
    } finally {
      handle.close();
    }
    self.postMessage({ id: msg.id, ok: true });
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
  }
};
`;

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "application/javascript" }));
  const w = new Worker(url);
  w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve();
    else p.reject(new Error(e.data.error || "OPFS write failed"));
  };
  w.onerror = (e) => {
    e.preventDefault();
    for (const p of pending.values()) p.reject(new Error(e.message || "OPFS write worker failed"));
    pending.clear();
    worker = null;
  };
  worker = w;
  return w;
}

/** Write `data` to the OPFS file at `parts` (relative to the OPFS root). */
export async function syncWriteOpfs(parts: string[], data: string | Blob | ArrayBuffer | Uint8Array): Promise<void> {
  if (typeof Worker === "undefined") throw new Error("OPFS writes are not supported in this browser.");
  let bytes: ArrayBuffer;
  if (typeof data === "string") bytes = new TextEncoder().encode(data).buffer as ArrayBuffer;
  else if (data instanceof Blob) bytes = await data.arrayBuffer();
  else if (data instanceof Uint8Array) bytes = data.slice().buffer as ArrayBuffer;
  else bytes = data.slice(0);
  const id = ++nextId;
  const done = new Promise<void>((resolve, reject) => pending.set(id, { resolve, reject }));
  getWorker().postMessage({ id, parts, bytes }, [bytes]);
  return done;
}
