import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("idb-keyval", () => ({ get: vi.fn(async () => undefined), set: vi.fn(async () => {}) }));
const picks = vi.hoisted(() => ({ n: 0, ids: [] as string[] }));
vi.mock("../ai/embeddingProvider", () => ({
  pickEmbeddingProvider: vi.fn(async () => {
    const id = `p${++picks.n}`;
    picks.ids.push(id);
    return { id, dims: 2, embed: async (t: string[]) => t.map(() => Float32Array.from([1, 0])) };
  }),
}));

import { __embedForTests, resetEmbeddingProvider } from "../ai/semanticSearch";

beforeEach(() => {
  localStorage.clear();
  picks.n = 0;
  resetEmbeddingProvider();
  vi.useRealTimers();
});

describe("embedding provider follows the settings", () => {
  it("re-picks after a policy or Ollama address change, and after a minute", async () => {
    await __embedForTests(["a"]);
    await __embedForTests(["b"]);
    expect(picks.n).toBe(1);
    localStorage.setItem("lumen.ai.policy", "local-only");
    await __embedForTests(["c"]);
    expect(picks.n).toBe(2);
    localStorage.setItem("lumen.ollama.baseUrl", "http://127.0.0.1:11434");
    await __embedForTests(["d"]);
    expect(picks.n).toBe(3);
    vi.useFakeTimers({ now: Date.now() + 61_000 });
    await __embedForTests(["e"]);
    expect(picks.n).toBe(4);
  });
});
