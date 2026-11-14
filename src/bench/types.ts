/**
 * The model benchmark (plan 7.8): what an engine adapter looks like. One
 * adapter per engine, in src/bench/engines/<id>.ts, exporting `engine`.
 * The page (bench/models.html → src/bench/page.ts) runs it in a real
 * browser; scripts/bench-models.mjs drives the page with Playwright,
 * scores the outputs against the golden set in Node and writes the numbers
 * to models/registry.json. A feature branch that adds an engine adds its
 * adapter here.
 */

export type BenchDevice = "webgpu" | "wasm" | "cpu";

export interface BenchItem {
  id: string;
  part: string;
  /** What `run` gets: JSON, with assets as data: URLs. */
  input: unknown;
}

export interface BenchEngine {
  /** Unique id, used on the command line: --engines bge-rerank,e5. */
  id: string;
  label: string;
  /** The golden set it is measured on (eval/golden/<set>). */
  set: string;
  /** The models/registry.json ids the numbers belong to (empty: a baseline, reported only). */
  models: string[];
  /** Load the model (download on a cold cache); which device the app chose. */
  load(): Promise<{ device: BenchDevice; model?: string }>;
  /** Work done once per part before the items (index or embed the corpus). */
  prepare?(part: string, shared: unknown): Promise<void>;
  /** One item; the output is scored in Node (scripts/bench/tasks.mjs). */
  run(item: BenchItem): Promise<unknown>;
  dispose?(): Promise<void>;
}

export interface BenchRun {
  engine: string;
  device: BenchDevice | null;
  model: string | null;
  loadMs: number | null;
  prepareMs: number;
  itemMs: number[];
  outputs: Record<string, unknown>;
  /** Peak of the page's JS heap during the run (Chromium's performance.memory), MB. */
  jsHeapPeakMB: number | null;
  error: string | null;
}

export interface BenchEnv {
  userAgent: string;
  webgpu: boolean;
  adapter: { vendor: string; architecture: string; device: string; description: string } | null;
  f16: boolean;
  maxBufferMB: number | null;
  cores: number | null;
  deviceMemoryGB: number | null;
}

/** A data: URL → Blob (images, audio). */
export async function dataUrlBlob(url: string): Promise<Blob> {
  return (await fetch(url)).blob();
}
