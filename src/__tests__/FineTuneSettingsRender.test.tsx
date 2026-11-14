import { describe, it, expect, vi, beforeEach } from "vitest";

// FineTuneSettings uses the store; we test the rendering states
// by mocking the store + the AI modules.

vi.mock("../ai/fineTune", async (importOriginal) => ({
  fineTuneJobActive: (await importOriginal<typeof import("../ai/fineTune")>()).fineTuneJobActive,
  startFineTune: vi.fn(),
  getFineTuneJob: vi.fn(),
}));

vi.mock("./PromptDialog", () => ({
  uiConfirm: vi.fn().mockResolvedValue(false),
}));

vi.mock("./AiToast", () => ({
  showAiToast: vi.fn(),
}));
// The component's own imports (the two above resolve next to this file).
vi.mock("../ui/PromptDialog", () => ({ uiConfirm: vi.fn().mockResolvedValue(false) }));
vi.mock("../ui/AiToast", () => ({ showAiToast: vi.fn() }));

describe("FineTuneSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not render when open=false", async () => {
    const { render } = await import("@testing-library/react");
    const { FineTuneSettings } = await import("../ui/FineTuneSettings");
    const { container } = render(
      <FineTuneSettings open={false} onClose={() => {}} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders dialog when open=true", async () => {
    const { render, screen } = await import("@testing-library/react");
    const { FineTuneSettings } = await import("../ui/FineTuneSettings");
    render(<FineTuneSettings open={true} onClose={() => {}} />);
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("has proper aria attributes", async () => {
    const { render } = await import("@testing-library/react");
    const { FineTuneSettings } = await import("../ui/FineTuneSettings");
    const { container } = render(<FineTuneSettings open={true} onClose={() => {}} />);
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.getAttribute("aria-modal")).toBe("true");
    expect(dialog!.getAttribute("aria-label")).toBeTruthy();
  });

  it("shows Train button when no model is set", async () => {
    const { render, screen } = await import("@testing-library/react");
    const { FineTuneSettings } = await import("../ui/FineTuneSettings");
    render(<FineTuneSettings open={true} onClose={() => {}} />);
    // Should have a train button
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThanOrEqual(2); // Train + Close
  });

  it("calls onClose when close button clicked", async () => {
    const { render, screen, fireEvent } = await import("@testing-library/react");
    const { FineTuneSettings } = await import("../ui/FineTuneSettings");
    const onClose = vi.fn();
    render(<FineTuneSettings open={true} onClose={onClose} />);
    // Click the close button (last button)
    const buttons = screen.getAllByRole("button");
    const closeBtn = buttons[buttons.length - 1];
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a validating (or queued) job survives closing the dialog: reopening resumes polling and saves the model", async () => {
    const { render, waitFor, cleanup } = await import("@testing-library/react");
    const { FineTuneSettings } = await import("../ui/FineTuneSettings");
    const ft = await import("../ai/fineTune");
    const { useAppStore } = await import("../store/useStore");
    const { uiConfirm } = await import("../ui/PromptDialog");
    useAppStore.setState({ aiKey: "sk-test", fineTunedModelId: null });
    vi.mocked(uiConfirm).mockResolvedValueOnce(true);
    // OpenAI's first status for a new job: still active, so the id must be kept (review: #194)
    vi.mocked(ft.startFineTune).mockResolvedValueOnce({ id: "ftjob-1", status: "validating_files", createdAt: 1, chunks: 3, estimatedTokens: 900 });
    cleanup();
    const { getByRole, unmount } = render(<FineTuneSettings open={true} onClose={() => {}} />);
    // By its name: the header's help button (W3.7) and the local LoRA section (6.12) come before it now.
    (await waitFor(() => getByRole("button", { name: "Train" }))).click(); // Train on my style
    await waitFor(() => expect(localStorage.getItem("lumen.fineTune.activeJob")).toContain("ftjob-1"));
    unmount(); // the dialog closes
    cleanup();
    vi.mocked(ft.getFineTuneJob).mockResolvedValueOnce({ id: "ftjob-1", status: "succeeded", fineTunedModel: "ft:gpt-4o-mini:me", createdAt: 1 });
    render(<FineTuneSettings open={true} onClose={() => {}} />);
    await waitFor(() => expect(useAppStore.getState().fineTunedModelId).toBe("ft:gpt-4o-mini:me"));
    expect(ft.getFineTuneJob).toHaveBeenCalledWith("ftjob-1");
    expect(localStorage.getItem("lumen.fineTune.activeJob")).toBeNull();
  });
});

describe("FineTuneSettings: the local route first (plan 6.12.4)", () => {
  it("shows the on-device LoRA section above the cloud fine-tune", async () => {
    const { render, waitFor, within, cleanup } = await import("@testing-library/react");
    cleanup();
    const { FineTuneSettings } = await import("../ui/FineTuneSettings");
    const { container } = render(<FineTuneSettings open={true} onClose={() => {}} />);
    const dlg = within(container);
    const local = await waitFor(() => dlg.getByTestId("lora-local"));
    const cloud = dlg.getByText("Or in the cloud (OpenAI)");
    expect(local.compareDocumentPosition(cloud) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dlg.getByTestId("lora-export").textContent).toBe("Export training data and script");
  });
});
