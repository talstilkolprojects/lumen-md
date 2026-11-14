import { describe, it, expect, vi } from "vitest";
import { createPullTracker, deleteOllamaModel, pullOllamaModel, validOllamaName, OllamaPullError } from "../ai/ollamaPull";

const ndjson = (records: unknown[], split = 0) => {
  const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const bytes = new TextEncoder().encode(text);
  // Chunk boundaries inside a record must not lose it.
  const cut = split || Math.floor(bytes.length / 3);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, cut));
        c.enqueue(bytes.slice(cut));
        c.close();
      },
    }),
  );
};

describe("ollama pull (plan 5.7)", () => {
  it("sums progress over layers and never goes back", () => {
    const track = createPullTracker();
    expect(track({ status: "pulling manifest" }).fraction).toBeNull();
    expect(track({ status: "pulling a", digest: "a", total: 100, completed: 50 }).fraction).toBe(0.5);
    expect(track({ status: "pulling b", digest: "b", total: 300, completed: 0 }).fraction).toBe(50 / 400);
    // A resent record with less done keeps the larger value.
    expect(track({ status: "pulling a", digest: "a", total: 100, completed: 10 }).completed).toBe(50);
    expect(track({ status: "pulling b", digest: "b", total: 300, completed: 400 }).completed).toBe(350);
    expect(track({ status: "success" })).toEqual({ status: "success", completed: 350, total: 400, fraction: 1 });
  });

  it("accepts Ollama and Hugging Face names, rejects the rest", () => {
    expect(validOllamaName("qwen3:4b")).toBe(true);
    expect(validOllamaName("hf.co/dicta-il/DictaLM-3.0-1.7B-Thinking-GGUF")).toBe(true);
    expect(validOllamaName("hf.co/bartowski/Qwen3-4B-GGUF:Q4_K_M")).toBe(true);
    expect(validOllamaName("localhost:5000/acme/model:latest")).toBe(true);
    expect(validOllamaName("registry.example.com:443/acme/model")).toBe(true);
    expect(validOllamaName("bad name")).toBe(false);
    expect(validOllamaName("")).toBe(false);
    expect(validOllamaName("a;rm -rf")).toBe(false);
  });

  it("posts the model, reports every record and resolves on success", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      ndjson([{ status: "pulling manifest" }, { status: "pulling a", digest: "a", total: 10, completed: 5 }, { status: "pulling a", digest: "a", total: 10, completed: 10 }, { status: "success" }], 23),
    );
    const seen: Array<number | null> = [];
    await pullOllamaModel("http://localhost:11434/", " qwen3:4b ", { fetchImpl: fetchImpl as unknown as typeof fetch, onProgress: (p) => seen.push(p.fraction) });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://localhost:11434/api/pull");
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ model: "qwen3:4b", stream: true });
    expect(seen).toEqual([null, 0.5, 1, 1]);
  });

  it("fails on an HTTP error, an error record, or a stream cut before success", async () => {
    const f = (r: Response) => (async () => r) as unknown as typeof fetch;
    await expect(pullOllamaModel("http://x", "a", { fetchImpl: f(new Response("nope", { status: 500 })) })).rejects.toThrow("Ollama API error 500: nope");
    await expect(pullOllamaModel("http://x", "a", { fetchImpl: f(ndjson([{ status: "pulling manifest" }, { error: "file does not exist" }])) })).rejects.toThrow("Ollama: file does not exist");
    await expect(pullOllamaModel("http://x", "a", { fetchImpl: f(ndjson([{ status: "pulling a", digest: "a", total: 10, completed: 3 }])) })).rejects.toBeInstanceOf(OllamaPullError);
    await expect(pullOllamaModel("http://x", "not a name", {})).rejects.toThrow(/Not a model name/);
  });

  it("deletes with DELETE /api/delete", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response("", { status: 200 }));
    await deleteOllamaModel("http://x", "qwen3:4b", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl.mock.calls[0][0]).toBe("http://x/api/delete");
    expect(fetchImpl.mock.calls[0][1]?.method).toBe("DELETE");
  });
});
