/**
 * The ledger header counts model downloads, and static files only when there
 * are any (review: #198). Since the canvas moved to Excalidraw (plan 4.19), no
 * tracked host is a static file: Excalidraw's fonts are served from the app.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { PrivacyLedgerPanel } from "../ui/PrivacyLedgerPanel";
import { __resetLedger, withLedger } from "../ai/privacyLedger";
import { setAiPolicy } from "../ai/policy";

describe("privacy ledger header", () => {
  beforeEach(() => {
    localStorage.clear();
    __resetLedger();
    setAiPolicy("local-only");
  });

  it("leaves the static-file count out when there are none", async () => {
    const f = withLedger((async () => new Response("x", { status: 200 })) as unknown as typeof fetch);
    await f("https://huggingface.co/x/resolve/main/model.onnx");
    render(<PrivacyLedgerPanel open onClose={() => {}} />);
    const header = screen.getByTestId("privacy-summary").textContent ?? "";
    expect(header).toContain("Model downloads: 1");
    expect(header).not.toContain("Static files");
  });
});
