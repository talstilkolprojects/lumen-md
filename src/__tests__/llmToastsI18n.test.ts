import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { warn, info } = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock("../store/useToastStore", () => ({
  toast: { info, warn, error: vi.fn() },
}));
vi.mock("../store/useStore", () => ({
  useAppStore: {
    getState: () => ({
      aiKey: null,
      useLocalAi: false,
      useFineTunedModel: false,
      fineTunedModelId: null,
    }),
  },
}));
vi.mock("../ai/ollamaProvider", () => ({
  isOllamaAvailable: vi.fn().mockResolvedValue(false),
  chatOllama: vi.fn(),
  getBaseUrl: () => "http://127.0.0.1:11434",
}));

import { applyLocale, loadLocale } from "../i18n";
import { chat } from "../ai/llm";

describe("llm.chat — Ollama unavailable toast", () => {
  beforeEach(() => {
    warn.mockClear();
    localStorage.setItem("lumen.ai.provider", "ollama");
  });
  afterEach(() => {
    localStorage.removeItem("lumen.ai.provider");
    applyLocale("en");
  });

  it("shows a localized toast with the configured URL, then stops under the default local-only policy (NO_LOCAL)", async () => {
    applyLocale("en");
    await expect(chat([{ role: "user", content: "hi" }])).rejects.toMatchObject({ code: "NO_LOCAL" });
    expect(warn).toHaveBeenCalledWith(
      "Ollama unavailable",
      expect.stringContaining("http://127.0.0.1:11434"),
    );
  });

  it("falls back to OpenAI under local-first (NO_KEY when no key is set)", async () => {
    localStorage.setItem("lumen.ai.policy", "local-first");
    try {
      await expect(chat([{ role: "user", content: "hi" }])).rejects.toMatchObject({ code: "NO_KEY" });
    } finally {
      localStorage.removeItem("lumen.ai.policy");
    }
  });

  it("uses the active locale (he)", async () => {
    await loadLocale("he");
    applyLocale("he");
    await expect(chat([{ role: "user", content: "hi" }])).rejects.toMatchObject({ code: "NO_LOCAL" });
    const [title, body] = warn.mock.calls[0];
    expect(title).toBe("Ollama לא זמין");
    expect(body).toContain("http://127.0.0.1:11434");
    expect(body).not.toContain("{url}");
  });
});
