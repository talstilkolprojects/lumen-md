/**
 * Tests for the fine-tune pipeline (γ.5 / F3).
 *
 * Mock the workspace listing + read so the test is hermetic — no
 * OPFS, no fetch. The buildTrainingJsonl pure path covers the bulk
 * of the logic; upload/job APIs are lightly smoke-tested with a
 * mocked fetch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../storage/workspace", () => {
  let files: { path: string; content: string; modified: number }[] = [];
  return {
    listWorkspace: async () =>
      files.map((f) => ({
        path: f.path,
        name: f.path,
        size: f.content.length,
        modified: f.modified,
      })),
    readWorkspaceFile: async (p: string) => {
      const f = files.find((x) => x.path === p);
      if (!f) throw new Error("missing " + p);
      return f.content;
    },
    __setFiles(next: typeof files) {
      files = next;
    },
  };
});

import * as workspaceMock from "../storage/workspace";
import { useAppStore } from "../store/useStore";
import {
  buildTrainingJsonl,
  uploadTrainingFile,
  createFineTuneJob,
  getFineTuneJob,
} from "../ai/fineTune";

beforeEach(() => {
  vi.unstubAllGlobals();
  useAppStore.setState({ aiKey: "sk-test", useFineTunedModel: false, fineTunedModelId: null });
});

const setFiles = (files: { path: string; content: string; modified: number }[]) =>
  (workspaceMock as unknown as { __setFiles(f: typeof files): void }).__setFiles(files);

const wordsBlock = (n: number) =>
  Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

describe("buildTrainingJsonl", () => {
  it("produces 0 chunks when the vault is empty", async () => {
    setFiles([]);
    const out = await buildTrainingJsonl();
    expect(out.chunks).toBe(0);
    expect(out.jsonl).toBe("");
  });

  it("ignores docs older than the look-back window", async () => {
    const old = Date.now() - 200 * 86_400_000;
    setFiles([
      { path: "old.md", content: wordsBlock(1600), modified: old },
    ]);
    const out = await buildTrainingJsonl({ windowDays: 90 });
    expect(out.chunks).toBe(0);
  });

  it("emits one JSONL line per 800-word chunk inside the window", async () => {
    setFiles([
      { path: "a.md", content: wordsBlock(2400), modified: Date.now() },
    ]);
    const out = await buildTrainingJsonl();
    expect(out.chunks).toBe(3); // 2400 / 800
    const lines = out.jsonl.trim().split("\n");
    expect(lines).toHaveLength(3);
    const first = JSON.parse(lines[0]);
    expect(Array.isArray(first.messages)).toBe(true);
    expect(first.messages[0].role).toBe("system");
    expect(first.messages[1].role).toBe("user");
    expect(first.messages[2].role).toBe("assistant");
  });

  it("strips frontmatter before chunking", async () => {
    const fm = "---\ntitle: test\ntags: [a, b]\n---\n";
    setFiles([
      { path: "x.md", content: fm + wordsBlock(900), modified: Date.now() },
    ]);
    const out = await buildTrainingJsonl();
    expect(out.chunks).toBe(1);
    const line = JSON.parse(out.jsonl.trim());
    expect(line.messages[1].content).not.toContain("title:");
    expect(line.messages[1].content).not.toContain("tags:");
  });

  it("respects the maxTokens cap", async () => {
    setFiles([
      { path: "huge.md", content: wordsBlock(20000), modified: Date.now() },
    ]);
    // 20 000 words ≈ 26 000 tokens by our estimator. Cap at 5 000 → ~3 chunks.
    const out = await buildTrainingJsonl({ maxTokens: 5_000 });
    expect(out.chunks).toBeLessThan(10);
    expect(out.estimatedTokens).toBeLessThanOrEqual(5_000 + 1500);
  });
});

describe("uploadTrainingFile", () => {
  it("rejects empty input", async () => {
    await expect(uploadTrainingFile("")).rejects.toThrow(/No training data/);
  });

  it("POSTs the JSONL as a fine-tune file and returns the id", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "file-abc" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const id = await uploadTrainingFile('{"x":1}\n');
    expect(id).toBe("file-abc");
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect(form.get("purpose")).toBe("fine-tune");
  });

  it("throws on non-200 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 400 })),
    );
    await expect(uploadTrainingFile('{"x":1}\n')).rejects.toThrow(/files upload failed/);
  });
});

describe("createFineTuneJob + getFineTuneJob", () => {
  it("createFineTuneJob returns the initial job record", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "ftjob-123",
            status: "queued",
            created_at: 1714000000,
          }),
          { status: 200 },
        ),
      ),
    );
    const job = await createFineTuneJob("file-abc");
    expect(job.id).toBe("ftjob-123");
    expect(job.status).toBe("queued");
    expect(job.createdAt).toBe(1714000000 * 1000);
  });

  it("getFineTuneJob surfaces fine_tuned_model when status=succeeded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "ftjob-123",
            status: "succeeded",
            fine_tuned_model: "ft:gpt-4o-mini-2024-07-18:abc:run",
            created_at: 1714000000,
          }),
          { status: 200 },
        ),
      ),
    );
    const job = await getFineTuneJob("ftjob-123");
    expect(job.fineTunedModel).toBe("ft:gpt-4o-mini-2024-07-18:abc:run");
  });
});

describe("store: useFineTunedModel guard", () => {
  it("toggleFineTunedModel refuses to flip ON when no model id is persisted", () => {
    useAppStore.setState({ useFineTunedModel: false, fineTunedModelId: null });
    useAppStore.getState().toggleFineTunedModel();
    expect(useAppStore.getState().useFineTunedModel).toBe(false);
  });

  it("toggleFineTunedModel flips when a model id IS persisted", () => {
    useAppStore.setState({
      useFineTunedModel: false,
      fineTunedModelId: "ft:gpt-4o-mini:abc:run",
    });
    useAppStore.getState().toggleFineTunedModel();
    expect(useAppStore.getState().useFineTunedModel).toBe(true);
    useAppStore.getState().toggleFineTunedModel();
    expect(useAppStore.getState().useFineTunedModel).toBe(false);
  });
});

describe("fineTuneJobActive (review: #194)", () => {
  it("every unfinished status is active, validating_files included", async () => {
    const { fineTuneJobActive } = await import("../ai/fineTune");
    for (const st of ["validating_files", "queued", "running", "paused_new_status"]) expect(fineTuneJobActive(st)).toBe(true);
    for (const st of ["succeeded", "failed", "cancelled", "", null, undefined]) expect(fineTuneJobActive(st)).toBe(false);
  });
});
