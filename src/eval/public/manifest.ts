/**
 * Manifests of public Hebrew benchmarks (plan W11.H5): eval/public/<id>.json.
 *
 * A manifest says which public set a number was measured on, precisely
 * enough to reproduce it: the dataset id and the revision it is pinned to,
 * the files and their sha256, the licence, the split, the normaliser and the
 * metrics. The data itself is never in the repository or in dist (the gate
 * in ./gate.ts fails on it): it is downloaded to eval/public/.data/<id>/,
 * which is git-ignored, by `npm run eval:public -- fetch <id>` on a machine
 * with network.
 *
 * A revision or sha256 of null means "not pinned yet": the manifest then
 * lists the pin in `owed`, and a run refuses to write a result until it is
 * pinned (a number measured on an unpinned set is not reproducible).
 */

export const TASKS = ["asr", "tts-roundtrip", "nikud", "g2p", "ocr-handwriting", "ocr", "llm", "bidi-conformance", "ner", "lemma", "retrieval"] as const;
export type PublicTask = (typeof TASKS)[number];

export interface DatasetFile {
  /** Path inside the dataset (or URL path for a plain download). */
  path: string;
  /** Hex sha256 of the downloaded file, null until pinned. */
  sha256: string | null;
  bytes?: number;
  /** Download URL when the dataset is not on a hub. */
  url?: string;
}

export interface PublicManifest {
  id: string;
  task: PublicTask;
  title: string;
  dataset: {
    hub: "huggingface" | "unicode" | "github" | "zenodo" | "other";
    /** "ivrit-ai/eval-d1", "google/fleurs" (config he_il), "UCD 16.0.0"… */
    id: string;
    config?: string;
    url: string;
    /** Git commit on the hub, or the published version for a versioned download; null = not pinned yet. */
    revision: string | null;
    files: DatasetFile[];
  };
  license: {
    id: string;
    url?: string;
    /** May the files be copied into this repository? Even when true they are not: the gate refuses dataset files in the repo. */
    redistribute: boolean;
    note?: string;
  };
  split: string;
  /** Loader that reads the downloaded files (./adapters/*). */
  format: string;
  /**
   * For sets the Hub stores as Parquet with embedded audio or images: the
   * export script that turns them into the loader's format, and where it
   * writes it (inside eval/public/.data/<id>/).
   */
  export?: { script: string; output: string };
  /** Normaliser id (./normalize.ts), "none" when the metric works on raw text. */
  normalizer: string;
  metrics: string[];
  /** Where a public leaderboard reports the same metric on the same set, so our number can be compared. */
  leaderboard?: string;
  /** Frozen subset (W11.H9): item ids and the sha256 of their sorted, newline-joined list. Null until frozen. */
  frozen?: { count: number; ids: string[] | null; sha256: string | null; rule: string };
  /** What still has to be done on a machine with network (pin, download, run), in words. */
  owed?: string[];
  /** Plan ids this manifest serves. */
  plan: string[];
}

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;

/** Problems with a manifest, empty when it is valid. `fileStem` is its file name without .json. */
export function validateManifest(m: unknown, fileStem?: string): string[] {
  const p: string[] = [];
  const x = m as Partial<PublicManifest> | null;
  if (!x || typeof x !== "object") return ["not an object"];
  if (typeof x.id !== "string" || !ID.test(x.id)) p.push(`id "${String(x.id)}" must be lower-case kebab`);
  if (fileStem !== undefined && x.id !== fileStem) p.push(`id "${String(x.id)}" must equal the file name "${fileStem}"`);
  if (!TASKS.includes(x.task as PublicTask)) p.push(`task "${String(x.task)}" is not one of ${TASKS.join("|")}`);
  if (typeof x.title !== "string" || !x.title.trim()) p.push("title is required");
  const d = x.dataset;
  if (!d || typeof d !== "object") p.push("dataset is required");
  else {
    if (!d.id || !d.url || !/^https:\/\//.test(d.url)) p.push("dataset.id and an https dataset.url are required");
    if (d.revision !== null && (typeof d.revision !== "string" || !d.revision.trim())) p.push("dataset.revision must be a string or null");
    if (d.hub === "huggingface" && d.revision !== null && !HEX40.test(d.revision)) p.push(`dataset.revision "${d.revision}" must be a 40-hex commit on the hub`);
    if (!Array.isArray(d.files) || !d.files.length) p.push("dataset.files must list at least one file");
    else
      for (const f of d.files) {
        if (!f.path) p.push("every dataset file needs a path");
        if (f.sha256 !== null && !HEX64.test(String(f.sha256))) p.push(`${f.path}: sha256 must be 64 hex or null`);
      }
    // A git commit pins every file of a GitHub repository; elsewhere each file needs its sha256.
    const commitPinned = d.hub === "github" && typeof d.revision === "string" && HEX40.test(d.revision);
    if (d.hub === "github" && d.revision !== null && !commitPinned) p.push(`dataset.revision "${d.revision}" must be a 40-hex commit`);
    const unpinned = d.revision === null || (!commitPinned && Array.isArray(d.files) && d.files.some((f) => f.sha256 === null));
    if (unpinned && !(x.owed ?? []).some((o) => /\bpin/i.test(o))) p.push("an unpinned revision or sha256 needs an `owed` entry that says where it is pinned");
  }
  if (!x.license || typeof x.license.id !== "string" || typeof x.license.redistribute !== "boolean") p.push("license.id and license.redistribute are required");
  if (typeof x.split !== "string" || !x.split) p.push("split is required");
  if (typeof x.format !== "string" || !x.format) p.push("format is required");
  if (typeof x.normalizer !== "string" || !x.normalizer) p.push("normalizer is required");
  if (!Array.isArray(x.metrics) || !x.metrics.length) p.push("metrics must list at least one metric");
  if (!Array.isArray(x.plan) || !x.plan.length) p.push("plan must list the plan ids it serves");
  if (x.frozen) {
    const f = x.frozen;
    if (!(f.count > 0)) p.push("frozen.count must be positive");
    if (f.ids !== null && (!Array.isArray(f.ids) || f.ids.length !== f.count)) p.push(`frozen.ids must hold exactly ${f.count} ids or be null`);
    if ((f.ids === null) !== (f.sha256 === null)) p.push("frozen.ids and frozen.sha256 are pinned together");
  }
  return p;
}

/** Is everything needed to reproduce a number pinned (revision, every file's sha256, the frozen subset)? */
export function isPinned(m: PublicManifest): boolean {
  const filesPinned = (m.dataset.hub === "github" && m.dataset.revision !== null) || m.dataset.files.every((f) => f.sha256 !== null);
  return m.dataset.revision !== null && filesPinned && (!m.frozen || m.frozen.ids !== null);
}

/** The sha256 a frozen id list is pinned with: of the ids, sorted, joined by "\n". */
export async function idsDigest(ids: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode([...ids].sort().join("\n"));
  const h = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, "0")).join("");
}
