/**
 * Results of public benchmarks and the gate on them (plan W11.H5).
 *
 * A result is eval/results/<manifest id>/<model>@<revision>.json (a "/" in
 * a model id becomes "__"). The gate, run by `npm run eval:public -- check`
 * in ci:local (never GitHub Actions), fails when:
 * - a manifest is invalid;
 * - a result is stale: it describes a model revision other than the one
 *   models/registry.json pins now, or a dataset revision other than its
 *   manifest's;
 * - a result has no reproduction command, or was made from a synthetic
 *   fixture (those live in tests, never in eval/results);
 * - a dataset file is in the repository or in dist: anything under
 *   eval/public/.data/, a file a manifest lists, or audio/image/Parquet
 *   files under eval/public or eval/results.
 */
import { validateManifest, type PublicManifest } from "./manifest";

export interface PublicResult {
  schema: 1;
  /** Manifest id (eval/public/<id>.json). */
  task: string;
  dataset: { id: string; revision: string | null; split: string };
  model: { id: string; revision: string | null };
  /** The engine that ran the model (onnxruntime-web WASM, whisper.cpp, …). */
  engine: string;
  normalizer: string;
  normalizerParity?: "verified" | "unverified";
  n: number;
  metrics: Record<string, number>;
  /** ISO date of the run. */
  date: string;
  /** The command that reproduces this file. */
  command: string;
  machine?: string;
  synthetic: boolean;
}

export const slugModel = (id: string): string => id.replace(/\//g, "__").replace(/[^A-Za-z0-9._@:+-]/g, "_");
export const resultPath = (task: string, modelId: string, revision: string | null): string => `eval/results/${task}/${slugModel(modelId)}@${revision ?? "unpinned"}.json`;

export interface RegistryModelRef {
  id: string;
  revision?: string | null;
  hosting?: { revision?: string | null; keyRev?: string | null };
}

/** The revision the registry pins a model to now (null: not pinned / not a hub model). */
export function registryRevision(e: RegistryModelRef | undefined): string | null {
  return e?.hosting?.revision ?? e?.revision ?? null;
}

const DATA_EXT = /\.(wav|flac|mp3|ogg|opus|m4a|parquet|arrow|tar|tgz|zip|png|jpe?g|tiff?)$/i;

export interface GateInput {
  manifests: { stem: string; json: unknown }[];
  results: { path: string; json: unknown }[];
  registry: readonly RegistryModelRef[];
  /** Repository-relative paths of tracked files, and of dist files (prefixed "dist/"). */
  files: readonly string[];
}

export function checkPublicEval(input: GateInput): string[] {
  const problems: string[] = [];
  const manifests = new Map<string, PublicManifest>();
  for (const m of input.manifests) {
    const p = validateManifest(m.json, m.stem);
    if (p.length) problems.push(`eval/public/${m.stem}.json: ${p.join("; ")}`);
    else manifests.set(m.stem, m.json as PublicManifest);
  }
  const reg = new Map(input.registry.map((e) => [e.id, e]));
  for (const r of input.results) {
    const x = r.json as Partial<PublicResult>;
    const at = (msg: string) => problems.push(`${r.path}: ${msg}`);
    if (!x || x.schema !== 1 || typeof x.task !== "string" || !x.model || !x.dataset) {
      at("not a schema-1 public result");
      continue;
    }
    if (x.synthetic !== false) at("synthetic (fixture) results do not belong in eval/results");
    if (typeof x.command !== "string" || !x.command.trim()) at("no reproduction command");
    if (typeof x.date !== "string" || Number.isNaN(Date.parse(x.date))) at("date must be an ISO date");
    const want = resultPath(x.task, x.model.id, x.model.revision);
    if (r.path !== want) at(`must be at ${want}`);
    const m = manifests.get(x.task);
    if (!m) at(`no manifest eval/public/${x.task}.json`);
    else if (x.dataset.revision !== m.dataset.revision) at(`stale: measured on dataset revision ${x.dataset.revision}, the manifest pins ${m.dataset.revision}`);
    const pinned = registryRevision(reg.get(x.model.id));
    if (reg.has(x.model.id) && pinned !== null && x.model.revision !== pinned) at(`stale: describes ${x.model.id}@${x.model.revision}, models/registry.json pins ${pinned}`);
  }
  const listed = new Set<string>();
  for (const m of manifests.values()) for (const f of m.dataset.files) if (f.path.includes("/")) listed.add(f.path);
  for (const f of input.files) {
    if (/^(dist\/)?eval\/public\/\.data\//.test(f) || /^dist\/eval\/public\/\.data\//.test(f)) problems.push(`${f}: downloaded benchmark data must not be committed or shipped`);
    else if (/^(dist\/)?eval\/(public|results)\//.test(f) && DATA_EXT.test(f)) problems.push(`${f}: a dataset file (audio, image, Parquet, archive) in the repo`);
    else if ([...listed].some((p) => f === p || f.endsWith(`/${p}`))) problems.push(`${f}: a file a benchmark manifest lists is in the repo or dist`);
  }
  return problems;
}

/** The latest result per (task, model), for the public page (W11.H13) and the app's gates. */
export function latestResults(results: readonly PublicResult[]): PublicResult[] {
  const best = new Map<string, PublicResult>();
  for (const r of results) {
    const k = `${r.task}\u0000${r.model.id}`;
    const cur = best.get(k);
    if (!cur || r.date > cur.date) best.set(k, r);
  }
  return [...best.values()].sort((a, b) => a.task.localeCompare(b.task) || a.model.id.localeCompare(b.model.id));
}
