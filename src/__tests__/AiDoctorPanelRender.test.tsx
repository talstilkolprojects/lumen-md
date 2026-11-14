import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../i18n", () => ({ t: (k: string, p?: Record<string, unknown>) => (p ? `${k} ${JSON.stringify(p)}` : k), registerEnglish: () => undefined }));
vi.mock("../lib/logger", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const runDoctor = vi.fn();
const persist = vi.fn(async () => "persisted" as const);
vi.mock("../agents/doctor", () => ({
  runDoctor,
  formatDoctorReport: () => "report text",
  LOCAL_SERVICES: { grammar: "http://localhost:8010/v2/check", research: "http://localhost:8787" },
}));
vi.mock("../storage/persistentStorage", () => ({ requestPersistentStorage: persist }));
const downloadHebrewDictionary = vi.fn(async () => 300000);
vi.mock("../ai/hebrewSpellService", () => ({ downloadHebrewDictionary }));
const clearGrammarCache = vi.fn();
vi.mock("../ai/grammar", () => ({ GRAMMAR_ENDPOINT_KEY: "lumen.grammar.endpoint", clearGrammarCache }));

const REPORT = {
  at: 0,
  origin: "http://localhost",
  summary: { ok: 1, warn: 1, fail: 1, skip: 0 },
  findings: [
    { id: "policy", title: "ai.doctor.check.policy", status: "ok", detail: "local-only · auto" },
    { id: "ollama.reach", title: "ai.doctor.check.ollama", status: "fail", detail: "http://localhost:11434 — Failed to fetch", fix: { label: "ai.doctor.fix.install", command: "ollama serve", url: "https://ollama.com/download" } },
    { id: "storage", title: "ai.doctor.check.storage", status: "warn", detail: "12 / 1000 MB · evictable", fix: { label: "ai.doctor.fix.persist", action: "persist" } },
  ],
};

describe("AiDoctorPanel", () => {
  beforeEach(() => {
    runDoctor.mockReset();
    runDoctor.mockResolvedValue(REPORT);
    persist.mockClear();
  });

  it("runs the doctor on open and lists every finding with its status and fix", async () => {
    const { AiDoctorPanel } = await import("../ui/AiDoctorPanel");
    render(<AiDoctorPanel open onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("doctor-ollama.reach")).toBeTruthy());
    expect(runDoctor).toHaveBeenCalledWith({ golden: false, signal: expect.any(AbortSignal) });
    expect(screen.getByTestId("doctor-ollama.reach").getAttribute("data-status")).toBe("fail");
    expect(screen.getByText("ollama serve")).toBeTruthy();
    expect(screen.getByText("ai.doctor.fix.install")).toBeTruthy();
    expect(screen.getByTestId("doctor-summary").textContent).toContain('"fail":1');
  });

  it("runs an in-app fix and re-checks", async () => {
    const { AiDoctorPanel } = await import("../ui/AiDoctorPanel");
    render(<AiDoctorPanel open onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("doctor-storage")).toBeTruthy());
    fireEvent.click(screen.getByText("ai.doctor.action.persist"));
    await waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(runDoctor).toHaveBeenCalledTimes(2));
  });

  it("downloads the Hebrew dictionary from its one-click fix (plan 7.4.2)", async () => {
    runDoctor.mockResolvedValue({ ...REPORT, findings: [{ id: "engines.spellHe", title: "ai.doctor.check.spellHe", status: "warn", fix: { label: "ai.doctor.fix.spellHe", action: "downloadHebrewDictionary" } }] });
    const { AiDoctorPanel } = await import("../ui/AiDoctorPanel");
    render(<AiDoctorPanel open onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("doctor-engines.spellHe")).toBeTruthy());
    fireEvent.click(screen.getByText("ai.doctor.action.downloadHebrewDictionary"));
    await waitFor(() => expect(downloadHebrewDictionary).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(runDoctor).toHaveBeenCalledTimes(2));
  });

  it("points grammar and research at the local services in one click (plan 7.4.2)", async () => {
    localStorage.clear();
    runDoctor.mockResolvedValue({ ...REPORT, findings: [{ id: "grammar", title: "ai.doctor.check.grammar", status: "warn", fix: { label: "ai.doctor.fix.docker", command: "docker compose -f docker/local-ai.yml up -d", action: "useLocalServices" } }] });
    const { AiDoctorPanel } = await import("../ui/AiDoctorPanel");
    render(<AiDoctorPanel open onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("doctor-grammar")).toBeTruthy());
    fireEvent.click(screen.getByText("ai.doctor.action.useLocalServices"));
    await waitFor(() => expect(clearGrammarCache).toHaveBeenCalled());
    expect(localStorage.getItem("lumen.grammar.endpoint")).toBe("http://localhost:8010/v2/check");
    expect(localStorage.getItem("lumen.research.endpoint")).toBe("http://localhost:8787");
    await waitFor(() => expect(runDoctor).toHaveBeenCalledTimes(2));
  });

  it("runs the golden cases on request", async () => {
    const { AiDoctorPanel } = await import("../ui/AiDoctorPanel");
    render(<AiDoctorPanel open onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("doctor-policy")).toBeTruthy());
    runDoctor.mockResolvedValueOnce({ ...REPORT, findings: [...REPORT.findings, { id: "golden.summarizer", title: "ai.doctor.check.golden", status: "ok", detail: "summarizer · ollama · qwen2.5:7b", ms: 1200 }] });
    fireEvent.click(screen.getByTestId("doctor-golden-run"));
    await waitFor(() => expect(screen.getByTestId("doctor-golden.summarizer")).toBeTruthy());
    expect(runDoctor).toHaveBeenLastCalledWith({ golden: true, signal: expect.any(AbortSignal) });
  });

  it("closes on Escape and renders nothing when closed", async () => {
    const { AiDoctorPanel } = await import("../ui/AiDoctorPanel");
    const onClose = vi.fn();
    const { container, rerender } = render(<AiDoctorPanel open onClose={onClose} />);
    // A real key press reaches the document (the focus trap's listener, plan 10.1);
    // a keydown dispatched on window alone never does.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    rerender(<AiDoctorPanel open={false} onClose={onClose} />);
    expect(container.firstChild).toBeNull();
  });
});
