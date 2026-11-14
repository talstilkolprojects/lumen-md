/**
 * 2.39 — a /regex/ search is bounded: a note above REGEX_MAX_CHARS is not
 * matched against the regex (and the search says how many were skipped),
 * and a regex search in the index worker that runs past its time limit is
 * stopped by restarting the worker, which gets every note again.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMemoryBackend, setVaultBackend, type VaultBackend } from "../storage/vault";
import { writeWorkspaceFile } from "../storage/workspace";
import { __resetWorkspaceIndex, searchWorkspace, type SearchResult } from "../storage/workspaceIndex";
import { VaultIndex } from "../storage/vaultIndexCore";
import { REGEX_MAX_CHARS } from "../search/queryOps";
import { workerEngine, type IndexRequest, type IndexResponse, type WorkerLike } from "../storage/vaultIndexProtocol";
import { handleIndexRequest } from "../storage/vaultIndexLocal";

const big = "x".repeat(REGEX_MAX_CHARS) + " needle";

describe("the /regex/ size cap (VaultIndex)", () => {
  const idx = new VaultIndex();
  idx.upsert({ path: "small.md", name: "small.md", content: "a needle here", modified: 2 });
  idx.upsert({ path: "other.md", name: "other.md", content: "nothing", modified: 1 });
  idx.upsert({ path: "big.md", name: "big.md", content: big, modified: 3 });

  it("leaves a note over the cap out of a /regex/, counts it, and still matches the others", () => {
    const r = idx.query("/needle/");
    expect(r.hits.map((h) => h.path)).toEqual(["small.md"]);
    expect(r).toMatchObject({ regexSkipped: 1, regexMaxChars: REGEX_MAX_CHARS });
  });

  it("does not list an unchecked note for a negated /regex/ either", () => {
    const r = idx.query("-/needle/");
    expect(r.hits.map((h) => h.path)).toEqual(["other.md"]);
    expect(r.regexSkipped).toBe(1);
  });

  it("counts only notes the other operators let through, and nothing without a /regex/", () => {
    expect(idx.query("path:small /needle/").regexSkipped).toBe(0);
    const plain = idx.query("needle");
    expect(plain.regexSkipped).toBe(0);
    expect(plain.hits.map((h) => h.path).sort()).toEqual(["big.md", "small.md"]);
    expect(plain.regexMaxChars).toBeUndefined();
  });

  it("search() keeps its plain list of hits", () => {
    expect(idx.search("/needle/").map((h) => h.path)).toEqual(["small.md"]);
  });
});

/** A worker over the real protocol; `hang` makes it never answer a /regex/ query (a runaway pattern). */
class FakeWorker implements WorkerLike {
  onmessage: ((e: MessageEvent<IndexResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  readonly index = new VaultIndex();
  terminated = false;
  constructor(private readonly hang: boolean) {}
  terminate(): void {
    this.terminated = true;
  }
  postMessage(message: IndexRequest): void {
    const req = JSON.parse(JSON.stringify(message)) as IndexRequest;
    if (this.terminated || (this.hang && req.op === "query" && req.query.includes("/"))) return;
    queueMicrotask(() => this.onmessage?.({ data: JSON.parse(JSON.stringify(handleIndexRequest(this.index, req))) } as MessageEvent<IndexResponse>));
  }
}

describe("the /regex/ time limit (workspace index → worker)", () => {
  let previous: VaultBackend | null = null;
  let workers: FakeWorker[] = [];

  beforeEach(async () => {
    previous = setVaultBackend(createMemoryBackend());
    workers = [];
    // The first worker hangs on a query; the one started after it answers.
    __resetWorkspaceIndex(() => {
      const w = new FakeWorker(workers.length === 0);
      workers.push(w);
      return workerEngine(w);
    });
    await writeWorkspaceFile("a.md", "aaaa needle");
    await writeWorkspaceFile("b.md", "plain text");
  });
  afterEach(() => {
    __resetWorkspaceIndex();
    setVaultBackend(previous);
  });

  it("stops a /regex/ search that runs past the limit, restarts the worker with every note, and says so", async () => {
    const infos: Array<Omit<SearchResult, "hits">> = [];
    const hits = await searchWorkspace("/(a+)+$/", { timeLimitMs: 50, onRegexInfo: (i) => infos.push(i) });
    expect(hits).toEqual([]);
    expect(infos).toEqual([{ regexSkipped: 0, regexTimedOut: true }]);
    expect(workers).toHaveLength(2);
    expect(workers[0].terminated).toBe(true);
    // The fresh worker holds the notes again, and answers.
    const again = await searchWorkspace("/needle/", { onRegexInfo: (i) => infos.push(i) });
    expect(again.map((h) => h.path)).toEqual(["a.md"]);
    expect(infos[1]).toEqual({ regexSkipped: 0 });
    expect(workers[1].index.stats().files).toBe(2);
  });

  it("does not arm the limit for a query without a /regex/", async () => {
    const hits = await searchWorkspace("needle", { timeLimitMs: 1 });
    expect(hits.map((h) => h.path)).toEqual(["a.md"]);
    expect(workers).toHaveLength(1);
    expect(workers[0].terminated).toBe(false);
  });
});
