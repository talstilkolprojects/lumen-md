/**
 * 14.2 — the feedback dialog: 0 data leaves without the user's click.
 * Typing, ticking the boxes and running the doctor make no request and open
 * nothing; "Open on GitHub" opens exactly the previewed issue, "Copy text"
 * copies exactly the previewed text.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

vi.mock("../i18n", () => ({ t: (k: string, p?: Record<string, unknown>) => (p ? `${k} ${JSON.stringify(p)}` : k), registerEnglish: () => undefined }));
vi.mock("../ai/policy", () => ({ getAiPolicy: () => "local-only" }));
vi.mock("../agents/doctorStrings", () => ({}));
const runDoctor = vi.fn();
vi.mock("../agents/doctor", () => ({
  runDoctor,
  formatDoctorReport: () => "✓ AI policy — local-only\n✗ Ollama — http://tal:pw@10.0.0.2:11434",
}));

const REPORT = { at: 0, origin: "http://localhost", summary: { ok: 1, warn: 0, fail: 1, skip: 0 }, findings: [] };

const open = vi.fn<(url?: string | URL, target?: string, features?: string) => Window | null>(() => null);
const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response("{}"));
const beacon = vi.fn<(url: string | URL, data?: BodyInit | null) => boolean>(() => true);
const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
let xhrCount = 0;

describe("FeedbackDialog", () => {
  beforeEach(() => {
    runDoctor.mockReset();
    runDoctor.mockResolvedValue(REPORT);
    for (const m of [open, fetchSpy, beacon, writeText]) m.mockClear();
    xhrCount = 0;
    vi.stubGlobal("open", open);
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal(
      "XMLHttpRequest",
      class {
        constructor() {
          xhrCount++;
        }
        open(): void {}
        send(): void {}
      },
    );
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const nothingLeft = () => {
    expect(open).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrCount).toBe(0);
    expect(beacon).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  };

  it("sends nothing while the user writes and ticks, then opens exactly the previewed issue", async () => {
    const { FeedbackDialog } = await import("../ui/FeedbackDialog");
    render(<FeedbackDialog options={{}} onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId("feedback-title"), { target: { value: "Tabs vanish" } });
    fireEvent.change(screen.getByTestId("feedback-description"), { target: { value: "All my tabs closed." } });
    fireEvent.click(screen.getByTestId("feedback-doctor"));
    await waitFor(() => expect(screen.getByTestId("feedback-preview").textContent).toContain("## AI doctor report"));
    expect(runDoctor).toHaveBeenCalledTimes(1);
    nothingLeft();

    const preview = screen.getByTestId("feedback-preview").textContent ?? "";
    expect(preview).toContain("Bug: Tabs vanish");
    expect(preview).toContain("All my tabs closed.");
    expect(preview).toContain("- AI policy: local-only");
    // The password in the doctor's URL is scrubbed even though the user agreed to the report.
    expect(preview).not.toContain("tal:pw");

    fireEvent.click(screen.getByTestId("feedback-open-github"));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    const [url, target] = open.mock.calls[0];
    expect(target).toBe("_blank");
    const u = new URL(String(url));
    expect(`${u.origin}${u.pathname}`).toBe("https://github.com/talstilkol/lumen-md/issues/new");
    expect(`${u.searchParams.get("title")}\n\n${u.searchParams.get("body")}`).toBe(preview);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrCount).toBe(0);
  });

  it("leaves out the app details and the doctor report unless ticked", async () => {
    const { FeedbackDialog } = await import("../ui/FeedbackDialog");
    render(<FeedbackDialog options={{ doctorReport: "✓ from the doctor panel" }} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("feedback-env"));
    const preview = screen.getByTestId("feedback-preview").textContent ?? "";
    expect(preview).not.toContain("## Environment");
    expect(preview).not.toContain("from the doctor panel");
    expect(runDoctor).not.toHaveBeenCalled();
    // A report handed in by the doctor panel is used as is once ticked — no second run.
    fireEvent.click(screen.getByTestId("feedback-doctor"));
    expect(screen.getByTestId("feedback-preview").textContent).toContain("✓ from the doctor panel");
    expect(runDoctor).not.toHaveBeenCalled();
    nothingLeft();
  });

  it("copies exactly the previewed text, and only on click", async () => {
    const { FeedbackDialog } = await import("../ui/FeedbackDialog");
    render(<FeedbackDialog options={{ kind: "idea" }} onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId("feedback-title"), { target: { value: "Dark sidebar" } });
    nothingLeft();
    fireEvent.click(screen.getByTestId("feedback-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const preview = screen.getByTestId("feedback-preview").textContent ?? "";
    expect(writeText.mock.calls[0][0]).toBe(`# ${preview}`);
    expect(open).not.toHaveBeenCalled();
  });

  it("needs a title before it opens GitHub", async () => {
    const { FeedbackDialog } = await import("../ui/FeedbackDialog");
    render(<FeedbackDialog options={{}} onClose={vi.fn()} />);
    const button = screen.getByTestId("feedback-open-github") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(open).not.toHaveBeenCalled();
  });

  it("Escape closes it", async () => {
    const onClose = vi.fn();
    const { FeedbackDialog } = await import("../ui/FeedbackDialog");
    render(<FeedbackDialog options={{}} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
