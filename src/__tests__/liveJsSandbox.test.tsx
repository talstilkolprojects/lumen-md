/**
 * T48 — live-js runs only on "Run", inside a sandboxed opaque-origin iframe.
 * jsdom doesn't load the runner page, so these tests drive the relay
 * protocol by hand: the iframe's attributes, message queueing until the
 * runner is ready, and that only well-formed messages from that iframe
 * reach the block.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LiveJsBlock, { __resetLiveJsApprovals } from "../plugins/LiveJsBlock";
import { RUNNER_CHANNEL, SandboxedWorker, liveJsRunnerUrl } from "../plugins/liveJsSandbox";
import { WORKER_SOURCE } from "../plugins/liveJsWorkerSource";

afterEach(() => {
  cleanup();
  __resetLiveJsApprovals();
  document.querySelectorAll("iframe[data-livejs-runner]").forEach((f) => f.remove());
});

function fromFrame(frame: HTMLIFrameElement, data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data, source: frame.contentWindow }));
}

describe("SandboxedWorker", () => {
  it("hosts the worker in a hidden allow-scripts-only iframe (no same-origin)", () => {
    const w = new SandboxedWorker(document, "/livejs-runner.html");
    const frame = document.querySelector<HTMLIFrameElement>("iframe[data-livejs-runner]")!;
    expect(frame).toBeTruthy();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe("/livejs-runner.html");
    w.terminate();
    expect(document.querySelector("iframe[data-livejs-runner]")).toBeNull();
  });

  it("queues runs until the runner is ready, then relays them", () => {
    const w = new SandboxedWorker(document, "/livejs-runner.html");
    const frame = document.querySelector<HTMLIFrameElement>("iframe[data-livejs-runner]")!;
    const sent = vi.spyOn(frame.contentWindow!, "postMessage");
    w.postMessage({ type: "run", runId: 1, source: "1", timeoutMs: 10 });
    expect(sent).not.toHaveBeenCalled();
    fromFrame(frame, { channel: RUNNER_CHANNEL, kind: "ready" });
    expect(sent).toHaveBeenCalledWith({ channel: RUNNER_CHANNEL, data: { type: "run", runId: 1, source: "1", timeoutMs: 10 } }, "*");
    w.terminate();
  });

  it("accepts only well-formed messages from its own iframe", () => {
    const w = new SandboxedWorker(document, "/livejs-runner.html");
    const frame = document.querySelector<HTMLIFrameElement>("iframe[data-livejs-runner]")!;
    const got: unknown[] = [];
    const errors: string[] = [];
    w.addEventListener("message", (e) => got.push(e.data));
    w.addEventListener("error", (e) => errors.push(e.message));
    const good = { type: "log", runId: 3, level: "log", parts: ["hi"] };
    // From another window: ignored.
    window.dispatchEvent(new MessageEvent("message", { data: { channel: RUNNER_CHANNEL, kind: "message", data: good }, source: window }));
    // Malformed payloads: ignored.
    fromFrame(frame, { channel: RUNNER_CHANNEL, kind: "message", data: { type: "eval", runId: 3 } });
    fromFrame(frame, { channel: RUNNER_CHANNEL, kind: "message", data: { type: "log", runId: "3", parts: ["x"] } });
    fromFrame(frame, { channel: RUNNER_CHANNEL, kind: "message", data: { type: "log", runId: 3, parts: [{}] } });
    fromFrame(frame, { channel: "other", kind: "message", data: good });
    fromFrame(frame, { channel: RUNNER_CHANNEL, kind: "message", data: good });
    fromFrame(frame, { channel: RUNNER_CHANNEL, kind: "error", message: "boom" });
    expect(got).toEqual([good]);
    expect(errors).toEqual(["boom"]);
    w.terminate();
  });

  it("builds the runner URL beneath the deploy base", () => {
    expect(liveJsRunnerUrl("/")).toBe("/livejs-runner.html");
    expect(liveJsRunnerUrl("/app")).toBe("/app/livejs-runner.html");
  });
});

describe("live-js worker lockdown", () => {
  it("removes network and storage APIs before user code runs", () => {
    for (const api of ["fetch", "XMLHttpRequest", "WebSocket", "WebSocketStream", "EventSource", "WebTransport", "importScripts", "indexedDB", "caches", "FontFace", "ShadowRealm"]) {
      expect(WORKER_SOURCE).toContain(`"${api}"`);
    }
    expect(WORKER_SOURCE.indexOf("Object.getPrototypeOf(o)")).toBeLessThan(WORKER_SOURCE.indexOf("var runner = new MakeFunction("));
    // The import-word check runs before the source is compiled.
    expect(WORKER_SOURCE.indexOf("hasImportWord(source)")).toBeGreaterThan(0);
    expect(WORKER_SOURCE.indexOf("hasImportWord(source)")).toBeLessThan(WORKER_SOURCE.indexOf("var runner = new MakeFunction("));
  });
});

describe("LiveJsBlock run-on-click", () => {
  it("does not run on open; Run starts the sandbox", () => {
    render(<LiveJsBlock source={'console.log("hi")'} />);
    expect(screen.getByTestId("livejs-idle")).toBeTruthy();
    expect(document.querySelector("iframe[data-livejs-runner]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(screen.queryByTestId("livejs-idle")).toBeNull();
    expect(document.querySelector("iframe[data-livejs-runner]")).toBeTruthy();
  });

  it("after one Run, other blocks of the same document run by themselves", () => {
    const first = render(<LiveJsBlock source="1" />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    first.unmount();
    render(<LiveJsBlock source="2" />);
    expect(screen.queryByTestId("livejs-idle")).toBeNull();
  });
});
