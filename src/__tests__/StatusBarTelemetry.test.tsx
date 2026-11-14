/**
 * Render test for the StatusBar's Telemetry toggle pill. Verifies that:
 *   - The telemetry pill always renders (it's not gated on any feature).
 *   - It starts OFF (plan 12.4: monitoring is opt-in) and clicking it
 *     records the user's consent.
 *   - The aria-pressed attribute reflects the current state.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StatusBar } from "../ui/StatusBar";

// Mock the telemetry module so we don't touch real localStorage
const consent = vi.hoisted(() => ({ on: false, set: [] as boolean[] }));
vi.mock("../lib/telemetry", () => ({
  getMonitoringConsent: () => consent.on,
  setMonitoringConsent: (v: boolean) => {
    consent.on = v;
    consent.set.push(v);
  },
  initTelemetry: vi.fn(),
  monitoringEndpoint: () => null,
}));

describe("StatusBar — Telemetry toggle pill", () => {
  beforeEach(() => {
    consent.on = false;
    consent.set.length = 0;
  });

  it("is off by default and turns consent on when clicked", () => {
    render(
      <StatusBar text="hello world" dirty={false} filename="x.md" />,
    );
    const pill = screen.getByTestId("status-telemetry");
    expect(pill.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(pill);
    expect(pill.getAttribute("aria-pressed")).toBe("true");
    expect(consent.set).toEqual([true]);
  });

  it("renders the telemetry pill", () => {
    render(
      <StatusBar text="hello world" dirty={false} filename="x.md" />,
    );
    const pill = screen.getByTestId("status-telemetry");
    expect(pill).toBeTruthy();
  });

  it("has aria-pressed attribute", () => {
    render(
      <StatusBar text="hello world" dirty={false} filename="x.md" />,
    );
    const pill = screen.getByTestId("status-telemetry");
    // aria-pressed should be a string "true" or "false"
    expect(["true", "false"]).toContain(pill.getAttribute("aria-pressed"));
  });

  it("toggles on click", () => {
    render(
      <StatusBar text="hello world" dirty={false} filename="x.md" />,
    );
    const pill = screen.getByTestId("status-telemetry");
    const before = pill.getAttribute("aria-pressed");
    fireEvent.click(pill);
    // After click, aria-pressed should flip
    const after = pill.getAttribute("aria-pressed");
    expect(after).not.toBe(before);
  });
});
