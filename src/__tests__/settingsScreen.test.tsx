/**
 * Plan 11.1 — the settings screen: tabs, search, a change that writes the
 * store, export, and the old dialogs rendered as tabs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../ui/AiToast", () => ({ showAiToast: vi.fn() }));
vi.mock("../storage/exportFormats", () => ({ downloadText: vi.fn() }));

import { SettingsScreen } from "../ui/SettingsScreen";
import { useAppStore } from "../store/useStore";
import { downloadText } from "../storage/exportFormats";
import { showAiToast } from "../ui/AiToast";
import { __resetRemoteImagesForTests, allowRemoteImageHosts, allowedRemoteImageHosts } from "../lib/remoteImages";

function file(text: string): File {
  const f = new File([text], "lumen-settings.json", { type: "application/json" });
  if (typeof (f as { text?: unknown }).text !== "function") {
    Object.defineProperty(f, "text", { value: async () => text });
  }
  return f;
}

describe("SettingsScreen", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ vimEnabled: false, spellCheck: true, mode: "split" });
    vi.mocked(downloadText).mockClear();
    vi.mocked(showAiToast).mockClear();
  });

  it("opens on General with every tab listed", () => {
    render(<SettingsScreen onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(screen.getAllByRole("tab").map((x) => x.textContent)).toEqual([
      "General",
      "Theme",
      "AI settings",
      "Privacy",
      "Collaboration settings",
      "Train AI on my style",
      "Trusted signing keys",
      "Organization",
    ]);
    expect(screen.getByRole("tab", { name: "General" }).getAttribute("aria-selected")).toBe("true");
  });

  it("the Privacy tab lists the allowed image hosts, and revoking one there blocks it again (W10.C18)", async () => {
    __resetRemoteImagesForTests();
    allowRemoteImageHosts(["images.example.org", "cdn.example.net"]);
    render(<SettingsScreen onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Privacy" }));
    await waitFor(() => expect(screen.getByTestId("image-hosts")).toBeTruthy());
    expect(screen.getByRole("heading", { name: /Allowed image hosts/ })).toBeTruthy();
    expect(screen.getByTestId("image-hosts").textContent).toContain("images.example.org");
    fireEvent.click(screen.getByRole("button", { name: /images\.example\.org/ }));
    await waitFor(() => expect(allowedRemoteImageHosts()).toEqual(["cdn.example.net"]));
    expect(screen.getByTestId("image-hosts").textContent).not.toContain("images.example.org");
    __resetRemoteImagesForTests();
  });

  it("search finds the Privacy tab by name", () => {
    render(<SettingsScreen onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("settings-search"), { target: { value: "privacy" } });
    expect(screen.getAllByRole("tab").map((x) => x.textContent)).toContain("Privacy");
  });

  it("search narrows the settings, and a change writes the store", () => {
    const { container } = render(<SettingsScreen onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("settings-search"), { target: { value: "vim" } });
    expect(container.querySelector('[data-setting="spellCheck"]')).toBeNull();
    const vim = container.querySelector('[data-setting="vimEnabled"]') as HTMLInputElement;
    expect(vim).toBeTruthy();
    fireEvent.click(vim);
    expect(useAppStore.getState().vimEnabled).toBe(true);
  });

  it("a choice writes the store", () => {
    const { container } = render(<SettingsScreen onClose={() => {}} />);
    fireEvent.change(container.querySelector('[data-setting="mode"]') as HTMLSelectElement, { target: { value: "preview" } });
    expect(useAppStore.getState().mode).toBe("preview");
  });

  it("a localStorage-backed switch writes its key", () => {
    const { container } = render(<SettingsScreen onClose={() => {}} />);
    fireEvent.click(container.querySelector('[data-setting="lumen.telemetry.optOut"]') as HTMLInputElement);
    expect(localStorage.getItem("lumen.telemetry.optOut")).toBe("1");
    fireEvent.click(container.querySelector('[data-setting="lumen.telemetry.optOut"]') as HTMLInputElement);
    expect(localStorage.getItem("lumen.telemetry.optOut")).toBeNull();
  });

  it("a search for a setting inside another tab moves to that tab", async () => {
    render(<SettingsScreen onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("settings-search"), { target: { value: "ollama" } });
    await waitFor(() => expect(screen.getByRole("tab", { name: "AI settings" }).getAttribute("aria-selected")).toBe("true"));
    expect(screen.queryByRole("tab", { name: "General" })).toBeNull();
  });

  it("a search with no match says so", () => {
    render(<SettingsScreen onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("settings-search"), { target: { value: "zzzz-nothing" } });
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByText("No setting matches")).toBeTruthy();
  });

  it("renders an existing dialog as a tab, without its own close button", async () => {
    render(<SettingsScreen tab="appearance" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("theme-settings")).toBeTruthy());
    // Only the screen's own close button: the embedded dialog drops its one.
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("Escape closes", () => {
    const onClose = vi.fn();
    render(<SettingsScreen onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" }); // the shared focus trap listens on the document (plan 10.1)
    expect(onClose).toHaveBeenCalled();
  });

  it("exports settings without secrets", () => {
    localStorage.setItem("lumen.ai.key.openai", "sk-secret");
    localStorage.setItem("lumen.ollama.model", "qwen2.5:7b");
    render(<SettingsScreen onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Export JSON/ }));
    const [name, text] = vi.mocked(downloadText).mock.calls[0];
    expect(name).toBe("lumen-settings.json");
    expect(text).toContain("qwen2.5:7b");
    expect(text).not.toContain("sk-secret");
  });

  it("imports a settings file and reports the count", async () => {
    render(<SettingsScreen onClose={() => {}} />);
    const body = JSON.stringify({ format: "lumen-settings", version: 1, app: { vimEnabled: true, mode: "bogus" }, local: {} });
    fireEvent.change(screen.getByTestId("settings-import-input"), { target: { files: [file(body)] } });
    await waitFor(() => expect(useAppStore.getState().vimEnabled).toBe(true));
    expect(useAppStore.getState().mode).toBe("split");
    expect(showAiToast).toHaveBeenCalledWith("1 settings imported, 1 skipped", "success");
  });

  it("refuses a file that isn't a settings export", async () => {
    render(<SettingsScreen onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("settings-import-input"), { target: { files: [file("{\"lumenTheme\":1}")] } });
    await waitFor(() => expect(showAiToast).toHaveBeenCalledWith("That file isn't a Lumen settings file.", "error"));
  });
});
