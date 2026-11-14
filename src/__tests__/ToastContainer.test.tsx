/**
 * src/components/Toast.tsx — the app-wide toast stack: roles per kind,
 * auto-dismiss, manual dismiss, and localized labels.
 * (The learn-more link and the action button are in toastLearnMore.test.tsx.)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ToastContainer } from "../components/Toast";
import { useToastStore, toast } from "../store/useToastStore";
import { applyLocale, loadLocale, t } from "../i18n";

beforeEach(() => useToastStore.getState().clear());
afterEach(() => {
  cleanup();
  applyLocale("en");
});

describe("ToastContainer", () => {
  it("renders nothing without toasts", () => {
    const { container } = render(<ToastContainer />);
    expect(container.innerHTML).toBe("");
  });

  it("announces info/success politely and warnings/errors assertively", () => {
    render(<ToastContainer />);
    act(() => {
      toast.info("Saved locally");
      toast.success("Exported", "notes.html");
      toast.warn("Offline");
      toast.error("Sync failed");
    });
    const region = screen.getByLabelText(t("toast.region"));
    expect(region.children).toHaveLength(4);
    const statuses = screen.getAllByRole("status");
    expect(statuses.map((s) => s.getAttribute("aria-live"))).toEqual(["polite", "polite"]);
    expect(statuses[1].textContent).toContain("notes.html");
    const alerts = screen.getAllByRole("alert");
    expect(alerts.map((a) => a.textContent)).toEqual(["Offline", "Sync failed"]);
    expect(alerts.every((a) => a.getAttribute("aria-live") === "assertive")).toBe(true);
  });

  it("dismisses a toast from its close button", () => {
    render(<ToastContainer />);
    act(() => {
      toast.error("Sticky error");
    });
    fireEvent.click(screen.getByRole("button", { name: t("toast.dismiss") }));
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("auto-dismisses after its ttl, while a sticky toast stays", async () => {
    render(<ToastContainer />);
    act(() => {
      useToastStore.getState().push({ kind: "info", title: "Short-lived", ttlMs: 30 });
      useToastStore.getState().push({ kind: "error", title: "Sticky" });
    });
    expect(screen.getByText("Short-lived")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Short-lived")).toBeNull());
    expect(screen.getByText("Sticky")).toBeTruthy();
  });

  it("uses the active locale for the dismiss label (Hebrew)", async () => {
    const he = await loadLocale("he");
    applyLocale("he");
    render(<ToastContainer />);
    act(() => {
      toast.error("x");
    });
    expect(he["toast.dismiss"]).not.toBe("Dismiss");
    expect(screen.getByRole("button", { name: he["toast.dismiss"] })).toBeTruthy();
  });
});
