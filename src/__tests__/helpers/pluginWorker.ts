/** A Worker stand-in for plugin tests: the host.worker.ts protocol over the real QuickJS sandbox, in this process. */
import { vi } from "vitest";
import { createSandbox, type Sandbox } from "../../plugins/runtime/sandbox";
import { grantsFrom } from "../../plugins/runtime/capabilities";
import type { HostToWorker, WorkerToHost } from "../../plugins/runtime/protocol";

export class FakePluginWorker {
  onmessage: ((ev: MessageEvent<WorkerToHost>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminate = vi.fn();
  private sandbox: Sandbox | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private emit(m: WorkerToHost) {
    queueMicrotask(() => this.onmessage?.({ data: m } as MessageEvent<WorkerToHost>));
  }
  /** As host.worker.ts does: CPU and memory after the load and after each event (W3.10). */
  private statsTimer: ReturnType<typeof setTimeout> | undefined;
  private stats() {
    clearTimeout(this.statsTimer);
    if (this.sandbox) this.emit({ type: "stats", ...this.sandbox.stats(), denied: Object.fromEntries(this.sandbox.denied) });
  }
  postMessage(m: HostToWorker) {
    if (m.type === "load") {
      void createSandbox({
        manifest: m.manifest,
        code: m.code,
        grants: grantsFrom(m.grants),
        limits: m.limits,
        host: {
          call: (method, args) =>
            new Promise((resolve, reject) => {
              const id = ++this.seq;
              this.pending.set(id, { resolve, reject });
              this.emit({ type: "call", id, method, args });
            }),
          log: (level, text) => this.emit({ type: "log", level, text }),
          fatal: (error) => this.emit({ type: "fatal", error }),
        },
      }).then(
        (sb) => {
          this.sandbox = sb;
          this.emit({ type: "ready", loadMs: 1 });
          this.stats();
        },
        (e: Error) => this.emit({ type: "fatal", error: e.message }),
      );
    } else if (m.type === "result") {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (!p) return;
      if (m.ok) p.resolve(m.value);
      else {
        const e = new Error(m.error);
        if (m.denied) e.name = "PluginDenied";
        p.reject(e);
      }
      clearTimeout(this.statsTimer);
      this.statsTimer = setTimeout(() => this.stats(), 100);
    } else if (m.type === "event") void this.sandbox?.dispatch(m.name, m.payload).then(() => this.stats());
    else if (m.type === "unload") {
      clearTimeout(this.statsTimer);
      this.sandbox?.dispose();
      this.emit({ type: "unloaded" });
    }
  }
}

export const fakePluginWorker = () => new FakePluginWorker() as unknown as Worker;
