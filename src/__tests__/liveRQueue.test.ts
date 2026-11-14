import { describe, it, expect, vi } from "vitest";

const log: string[] = [];
let initHangs = false;
let initGate: Promise<void> | null = null;
let created = 0;
// webR is not bundled (plan W1.34): rRuntime loads it through webrModule.
vi.mock("../plugins/r/webrModule", () => {
  class Shelter {
    async captureR(code: string) {
      log.push(`start ${code}`);
      await new Promise((r) => setTimeout(r, code === "slow" ? 30 : 1));
      log.push(`end ${code}`);
      return { output: [{ type: "stdout", data: code }] };
    }
    async purge() {}
  }
  class WebR {
    Shelter = Shelter;
    constructor() {
      created++;
    }
    init() {
      return initHangs ? new Promise<void>(() => {}) : (initGate ?? Promise.resolve());
    }
    async flush() {
      return [];
    }
    async evalRVoid(c: string) {
      log.push(c.startsWith("webr::canvas") ? "open device" : "close devices");
    }
    close() {}
  }
  return { loadWebRModule: async () => ({ WebR, ChannelType: { PostMessage: 1 } }) };
});

describe("runR", () => {
  it("serialises runs on the shared webR instance", async () => {
    const { runR } = await import("../plugins/r/rRuntime");
    const started: string[] = [];
    const [a, b] = await Promise.all([
      runR("slow", undefined, { onStart: () => started.push("slow") }),
      runR("fast", undefined, { onStart: () => started.push("fast") }),
    ]);
    expect(a?.lines[0].text).toBe("slow");
    expect(b?.lines[0].text).toBe("fast");
    expect(started).toEqual(["slow", "fast"]);
    // The second run's device opens only after the first closed its own.
    expect(log).toEqual([
      "open device", "start slow", "end slow", "close devices",
      "open device", "start fast", "end fast", "close devices",
    ]);
  });

  it("skips a run cancelled while queued", async () => {
    const { runR } = await import("../plugins/r/rRuntime");
    let cancelled = false;
    const first = runR("slow");
    const second = runR("never", undefined, { isCancelled: () => cancelled });
    cancelled = true;
    await first;
    expect(await second).toBeNull();
    expect(log).not.toContain("start never");
  });

  it("a boot that hangs is dropped after the budget, whichever block started it", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const rt = await import("../plugins/r/rRuntime");
    initHangs = true;
    const before = created;
    const first = rt.getWebR();
    const failed = expect(first).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(rt.BOOT_TIMEOUT_MS + 1);
    await failed;
    initHangs = false;
    await rt.getWebR(); // a fresh instance, not the dead one
    expect(created).toBe(before + 2);
    vi.useRealTimers();
  });

  it("boots a runtime reset by an earlier run before onStart (outside the run's timer)", async () => {
    vi.resetModules();
    const rt = await import("../plugins/r/rRuntime");
    await rt.getWebR();
    let release: () => void = () => {};
    const events: string[] = [];
    const first = rt.runR("slow", undefined, {
      onStart: () => {
        events.push("start slow");
        // Stop / timeout while another run is queued: the runtime is reset
        // and its replacement takes a while to boot.
        initGate = new Promise<void>((r) => (release = r));
        void rt.resetWebR();
      },
    });
    const second = rt.runR("fast", undefined, { onStart: () => events.push("start fast") });
    await first.catch(() => { /* why: the first run is cancelled on purpose; only the queue order is under test */ });
    await new Promise((r) => setTimeout(r, 5));
    // Still booting: the queued run has not started (its timer isn't armed).
    expect(events).toEqual(["start slow"]);
    release();
    initGate = null;
    expect((await second)?.lines[0].text).toBe("fast");
    expect(events).toEqual(["start slow", "start fast"]);
  });
});
