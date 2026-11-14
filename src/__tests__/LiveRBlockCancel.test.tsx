/**
 * Live R block: Stop / unmount reset the shared webR instance only when
 * this block's run is the one executing, never while it is still queued.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const resetWebR = vi.fn(async () => {});
let release: (() => void) | null = null;
let startHook: (() => void) | undefined;
let bootHangs = false;
vi.mock("../plugins/r/rRuntime", () => ({
  webrAvailable: async () => true,
  getWebR: () => (bootHangs ? new Promise(() => {}) : Promise.resolve({})),
  resetWebR: () => resetWebR(),
  // A run that starts only when the test says so (queued behind another).
  runR: (_code: string, _plot: unknown, hooks: { onStart?: () => void; isCancelled?: () => boolean } = {}) => {
    startHook = () => hooks.onStart?.();
    return new Promise((resolve) => {
      release = () => resolve(hooks.isCancelled?.() ? null : { lines: [], images: [] });
    });
  },
}));

import LiveRBlock from "../plugins/LiveRBlock";

afterEach(() => {
  cleanup();
  resetWebR.mockClear();
  release = null;
  startHook = undefined;
  bootHangs = false;
  vi.useRealTimers();
});

// Enough microtask turns for Run to reach runR: the webR availability check
// (plan W1.34), the runtime import and the boot race each take a few.
const flush = () => act(async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
});

describe("LiveRBlock cancellation", () => {
  it("Stop on a queued run doesn't reset webR (another block owns it)", async () => {
    render(<LiveRBlock source="x" />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(resetWebR).not.toHaveBeenCalled();
    release?.();
    await flush();
  });

  it("Stop on an executing run resets webR", async () => {
    render(<LiveRBlock source="x" />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await flush();
    act(() => startHook?.());
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(resetWebR).toHaveBeenCalledTimes(1);
  });

  it("unmounting during execution resets webR; unmounting while queued doesn't", async () => {
    const a = render(<LiveRBlock source="x" />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await flush();
    a.unmount();
    expect(resetWebR).not.toHaveBeenCalled();

    const b = render(<LiveRBlock source="y" />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await flush();
    act(() => startHook?.());
    b.unmount();
    expect(resetWebR).toHaveBeenCalledTimes(1);
  });

  it("drops a boot that hangs past the load timeout, so the next Run retries", async () => {
    vi.useFakeTimers();
    bootHangs = true;
    render(<LiveRBlock source="x" />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_001);
    });
    expect(resetWebR).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("live-r").getAttribute("data-state")).toBe("error");
  });
});
