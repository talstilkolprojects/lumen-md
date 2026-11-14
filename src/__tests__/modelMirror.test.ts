/**
 * Plan W4.14 — Lumen's model mirror: the CORS proxy in front of GitHub
 * Releases (edge-workers/model-mirror) and the owner's pin / upload script
 * (scripts/models/mirror.mjs), offline.
 */
import { describe, it, expect } from "vitest";
import { handle, parseMirrorPath, releaseUrl } from "../../edge-workers/model-mirror/worker";
import { fileDtype, keepPath, parseArgs, releaseNotes, selectModels } from "../../scripts/models/mirror.mjs";

const env = { REPO: "talstilkol/lumen-md" };

describe("W4.14 mirror proxy", () => {
  it("maps /<tag>/<path…> to the flat release asset", () => {
    expect(parseMirrorPath("/models-whisper-base/onnx/encoder_model.onnx")).toEqual({ tag: "models-whisper-base", asset: "onnx__encoder_model.onnx" });
    expect(parseMirrorPath("/models-whisper-base/onnx__encoder_model.onnx")).toEqual({ tag: "models-whisper-base", asset: "onnx__encoder_model.onnx" });
    expect(releaseUrl("talstilkol/lumen-md", "models-x", "a__b.onnx")).toBe("https://github.com/talstilkol/lumen-md/releases/download/models-x/a__b.onnx");
  });

  it("reaches only models-* tags and plain file names", () => {
    expect(parseMirrorPath("/v1.0.0/app.dmg")).toBeNull();
    expect(parseMirrorPath("/models-x/../secret")).toBeNull();
    expect(parseMirrorPath("/models-x/%2e%2e/secret")).toBeNull();
    expect(parseMirrorPath("/models-x")).toBeNull();
  });

  it("streams the asset with CORS headers and passes Range through", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response("abc", { status: 206, headers: { "Content-Length": "3", "Content-Range": "bytes 0-2/10", "Set-Cookie": "x=1" } });
    };
    const res = await handle(new Request("https://mirror.example.com/models-x/onnx/m.onnx", { headers: { Range: "bytes=0-2" } }), env, fetcher);
    expect(res.status).toBe(206);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Content-Range")).toBe("bytes 0-2/10");
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(await res.text()).toBe("abc");
    expect(seen[0].url).toBe("https://github.com/talstilkol/lumen-md/releases/download/models-x/onnx__m.onnx");
    expect((seen[0].init?.headers as Record<string, string>).Range).toBe("bytes=0-2");
  });

  it("answers the preflight, refuses writes and unknown paths without asking GitHub", async () => {
    let asked = 0;
    const fetcher = async () => {
      asked++;
      return new Response("x");
    };
    expect((await handle(new Request("https://m.example.com/models-x/a", { method: "OPTIONS" }), env, fetcher)).status).toBe(204);
    expect((await handle(new Request("https://m.example.com/models-x/a", { method: "POST" }), env, fetcher)).status).toBe(405);
    expect((await handle(new Request("https://m.example.com/latest/app.zip"), env, fetcher)).status).toBe(404);
    expect(asked).toBe(0);
  });

  it("a missing asset stays an error, never cached", async () => {
    const res = await handle(new Request("https://m.example.com/models-x/a.onnx"), env, async () => new Response("Not Found", { status: 404 }));
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("W4.14 mirror script (owner commands)", () => {
  const whisper = { id: "onnx-community/whisper-base", class: "allowed", delivery: "download", hosting: { hf: "onnx-community/whisper-base", cache: "transformers-cache", dtypes: ["fp32", "q4", "q8"] } };
  const mlc = { id: "Qwen3-0.6B", class: "allowed", delivery: "download", hosting: { hf: "mlc-ai/Qwen3-0.6B-q4f16_1-MLC", cache: "webllm/model" } };

  it("mirrors what the app loads: configs and the app's dtypes, no PyTorch weights", () => {
    expect(keepPath(whisper, "config.json")).toBe(true);
    expect(keepPath(whisper, "tokenizer.json")).toBe(true);
    expect(keepPath(whisper, "onnx/encoder_model.onnx")).toBe(true);
    expect(keepPath(whisper, "onnx/decoder_model_merged_q4.onnx")).toBe(true);
    expect(keepPath(whisper, "onnx/decoder_model_merged_q4f16.onnx")).toBe(false);
    expect(keepPath(whisper, "model.safetensors")).toBe(false);
    expect(keepPath(whisper, "README.md")).toBe(false);
    expect(keepPath(mlc, "params_shard_0.bin")).toBe(true);
    expect(keepPath(mlc, ".gitattributes")).toBe(false);
    expect(fileDtype("onnx/encoder_model_quantized.onnx")).toBe("q8");
    expect(fileDtype("tokenizer.json")).toBe("config");
  });

  it("mirrors allowed models only, unless asked", () => {
    const llama = { id: "Llama-3.2-1B-Instruct", class: "conditional", delivery: "download", hosting: {} };
    const ollama = { id: "qwen3:8b", class: "allowed", delivery: "ollama-pull" };
    expect(selectModels([whisper, llama, ollama], {}).map((m: { id: string }) => m.id)).toEqual(["onnx-community/whisper-base"]);
    expect(selectModels([whisper, llama], { includeConditional: true })).toHaveLength(2);
    expect(selectModels([whisper, llama], { only: ["Llama-3.2-1B-Instruct"] })).toHaveLength(1);
  });

  it("parses its modes and puts the licence and attribution in the release notes", () => {
    expect(parseArgs(["--check", "--strict"])).toMatchObject({ mode: "check", strict: true });
    expect(parseArgs(["--upload", "--only", "a,b", "--dry-run"])).toMatchObject({ mode: "upload", only: ["a", "b"], dryRun: true });
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
    const notes = releaseNotes({ id: "x", source: "https://huggingface.co/x", license: "MIT", attribution: "© someone", hosting: { revision: "abc" } });
    expect(notes).toContain("Licence: MIT");
    expect(notes).toContain("Attribution: © someone");
    expect(notes).toContain("@ abc");
  });
});
