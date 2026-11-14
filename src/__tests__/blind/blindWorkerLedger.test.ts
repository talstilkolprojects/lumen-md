/**
 * Blind tests (plan W6.15, lane M2): the worker privacy ledger and the
 * worker side of airplane mode (src/ai/workerLedger.ts).
 *
 * Written from the spec only: the module's doc comments and public API as
 * declarations emitted by offline tsc (no function bodies), plan 2.4 and
 * W5.9, and docs/src/content/docs/ai/privacy.md. The test list (W1–W10) was
 * written before any implementation was opened. Channels are fakes with the
 * BroadcastChannel surface the API names (postMessage, addEventListener).
 * One test (W5) was revised after its first run; it says why.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetWorkerLedger,
  AIRPLANE_WAIT_MS,
  installWorkerLedger,
  reportWorkerDownload,
  type AirplaneMessage,
  type WorkerLedgerMessage,
} from "../../ai/workerLedger";

const APP = "https://lumen-md.vercel.app/assets/embed.worker.js";

function fakes() {
  const ledger: WorkerLedgerMessage[] = [];
  const air: AirplaneMessage[] = [];
  const listeners: Array<(e: MessageEvent) => void> = [];
  const calls: string[] = [];
  const scope = {
    name: "embed-worker",
    location: { href: APP, pathname: "/assets/embed.worker.js" },
    fetch: (async (input: RequestInfo | URL) => {
      calls.push(String(input instanceof Request ? input.url : input));
      return new Response("0123456789", { status: 200, headers: { "content-length": "10" } });
    }) as typeof fetch,
  };
  const channel = { postMessage: (m: unknown) => void ledger.push(m as WorkerLedgerMessage) };
  const airChannel = {
    postMessage: (m: unknown) => void air.push(m as AirplaneMessage),
    addEventListener: ((_: string, fn: (e: MessageEvent) => void) => void listeners.push(fn)) as BroadcastChannel["addEventListener"],
  };
  const answer = (on: boolean) => listeners.forEach((fn) => fn({ data: { kind: "state", on } } as MessageEvent));
  return { ledger, air, calls, scope, channel, airChannel, answer };
}

const until = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
};

afterEach(() => __resetWorkerLedger());

describe("worker ledger (blind, W1–W10)", () => {
  it("W1: every request is reported: start (url, method, bytes out, worker) then end (status, bytes in)", async () => {
    const f = fakes();
    expect(installWorkerLedger(f.scope, f.channel, f.airChannel)).toBe(true);
    f.answer(false);
    const res = await f.scope.fetch("https://huggingface.co/model.onnx", { method: "POST", body: "abcde" });
    await res.text();
    await until(() => f.ledger.some((m) => m.kind === "end"));
    const start = f.ledger.find((m) => m.kind === "start");
    const end = f.ledger.find((m) => m.kind === "end");
    expect(start).toMatchObject({ url: "https://huggingface.co/model.onnx", method: "POST", bytesOut: 5 });
    expect(start && start.kind === "start" && start.worker.length).toBeGreaterThan(0);
    expect(end).toMatchObject({ status: 200 });
    expect(end && end.kind === "end" && end.id).toBe(start && start.kind === "start" && start.id);
    expect(f.calls).toEqual(["https://huggingface.co/model.onnx"]);
  });

  it("W2: installing twice, or into a scope with no fetch, says false", () => {
    const f = fakes();
    expect(installWorkerLedger(f.scope, f.channel, f.airChannel)).toBe(true);
    expect(installWorkerLedger(f.scope, f.channel, f.airChannel)).toBe(false);
    __resetWorkerLedger();
    expect(installWorkerLedger({ fetch: undefined as unknown as typeof fetch }, f.channel, f.airChannel)).toBe(false);
  });

  it("W3: the worker asks the window for the switch (hello) when it installs", () => {
    const f = fakes();
    installWorkerLedger(f.scope, f.channel, f.airChannel);
    expect(f.air).toContainEqual({ kind: "hello" });
  });

  it("W4: switch on — a request to another host fails in the worker, never reaches fetch, and is reported as blocked", async () => {
    const f = fakes();
    installWorkerLedger(f.scope, f.channel, f.airChannel);
    f.answer(true);
    await expect(f.scope.fetch("https://huggingface.co/x")).rejects.toThrow();
    expect(f.calls).toEqual([]);
    expect(f.air).toContainEqual(expect.objectContaining({ kind: "attempt", url: "https://huggingface.co/x", blocked: true }));
  });

  // W5 was first written as "the app's own host still loads". It failed: the
  // worker blocks the deployment's own host too, and lets only this device
  // (localhost, 127.0.0.1, ::1, blob:, data:) through. The doc comment says
  // "another host"; airplane mode's docs say every network path stops. The
  // stricter reading is the safe one, so the test now pins it (finding F-12,
  // a spec ambiguity, not a bug). The implementation was opened for this only.
  it("W5: switch on — this device (localhost, blob:, data:) still loads; the deployment's own host is network too and is blocked (F-12)", async () => {
    const f = fakes();
    installWorkerLedger(f.scope, f.channel, f.airChannel);
    f.answer(true);
    await expect(f.scope.fetch("http://localhost:8080/models/tiny.onnx")).resolves.toBeTruthy();
    await expect(f.scope.fetch("http://127.0.0.1:11434/api/tags")).resolves.toBeTruthy();
    expect(f.calls).toEqual(["http://localhost:8080/models/tiny.onnx", "http://127.0.0.1:11434/api/tags"]);
    await expect(f.scope.fetch("https://lumen-md.vercel.app/models/tiny.onnx")).rejects.toThrow();
    expect(f.calls).toHaveLength(2);
  });

  it("W6: a host that only looks like the app's is another host", async () => {
    const f = fakes();
    installWorkerLedger(f.scope, f.channel, f.airChannel);
    f.answer(true);
    for (const u of ["https://lumen-md.vercel.app.evil.example/x", "https://evil.example/lumen-md.vercel.app/x", "http://lumen-md.vercel.app/x"]) {
      await expect(f.scope.fetch(u), u).rejects.toThrow();
    }
    expect(f.calls).toEqual([]);
  });

  it("W7: switch off — other hosts pass, and the attempt is still reported, not blocked", async () => {
    const f = fakes();
    installWorkerLedger(f.scope, f.channel, f.airChannel);
    f.answer(false);
    await expect(f.scope.fetch("https://huggingface.co/y")).resolves.toBeTruthy();
    expect(f.calls).toEqual(["https://huggingface.co/y"]);
    expect(f.air).toContainEqual(expect.objectContaining({ kind: "attempt", url: "https://huggingface.co/y", blocked: false }));
  });

  it("W8: no answer within AIRPLANE_WAIT_MS — fail closed; a later 'off' lets requests through again", async () => {
    expect(AIRPLANE_WAIT_MS).toBe(3000);
    const f = fakes();
    installWorkerLedger(f.scope, f.channel, f.airChannel);
    await new Promise((r) => setTimeout(r, AIRPLANE_WAIT_MS + 200));
    await expect(f.scope.fetch("https://huggingface.co/z")).rejects.toThrow();
    expect(f.calls).toEqual([]);
    f.answer(false);
    await expect(f.scope.fetch("https://huggingface.co/z")).resolves.toBeTruthy();
    expect(f.calls).toEqual(["https://huggingface.co/z"]);
  }, 10_000);

  it("W9: the switch turning on later stops the next request (later answers keep updating it)", async () => {
    const f = fakes();
    installWorkerLedger(f.scope, f.channel, f.airChannel);
    f.answer(false);
    await f.scope.fetch("https://huggingface.co/a");
    f.answer(true);
    await expect(f.scope.fetch("https://huggingface.co/b")).rejects.toThrow();
    expect(f.calls).toEqual(["https://huggingface.co/a"]);
  });

  it("W10: reportWorkerDownload is null before install; after, it records a start with no byte count and settles with the given status", async () => {
    expect(reportWorkerDownload("https://huggingface.co/m.bin")).toBeNull();
    const f = fakes();
    installWorkerLedger(f.scope, f.channel, f.airChannel);
    f.answer(false);
    const settle = reportWorkerDownload("https://huggingface.co/m.bin");
    expect(typeof settle).toBe("function");
    settle!(0);
    await until(() => f.ledger.some((m) => m.kind === "end"));
    const start = f.ledger.find((m) => m.kind === "start" && m.url === "https://huggingface.co/m.bin");
    expect(start).toBeTruthy();
    const end = f.ledger.find((m) => m.kind === "end");
    expect(end).toMatchObject({ status: 0, bytesIn: null });
  });
});
