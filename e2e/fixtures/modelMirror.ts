/**
 * Plan W6.33: what e2e/model-mirror.spec.ts (and the offline browser run of
 * the same scenario) needs: a mirror built from models/registry.json, the
 * Hugging Face hosts to block, and the in-page scenario.
 *
 * Two modes:
 *  - synthetic (default, no network): every model that may be a default
 *    gets the files it would have once pinned (its real paths when the
 *    registry lists them), with made-up bytes whose sha256 is in the
 *    synthetic registry; the mirror is a route on the page's own origin
 *    (so the app's CSP allows it). This checks the whole chain in a real
 *    browser: Hugging Face first and blocked, the mirror next, the bytes
 *    checked, the files in the cache the library reads.
 *  - real (MODEL_MIRROR_URL set, on a host with network): the registry as
 *    it is, the deployed mirror, Hugging Face still blocked.
 */
import { createHash } from "node:crypto";
import type { HostedFile, HostedModel } from "../../src/ai/modelHosting";

/** Every request to these hosts is aborted (and counted). */
export const HF_HOSTS = [/^https:\/\/huggingface\.co\//, /^https:\/\/[\w-]+\.huggingface\.co\//, /^https:\/\/([\w-]+\.)?hf\.co\//];

/** The mirror path on the page's own origin in synthetic mode. */
export const MIRROR_PATH = "/__model-mirror-e2e";

const isDefault = (m: HostedModel) => m.delivery === "download" && m.class === "allowed" && m.runs === "browser";

/** Bytes for one synthetic file: the same for the same model tag and path. */
export function syntheticBytes(tag: string, path: string): Buffer {
  const seed = createHash("sha256").update(`${tag}|${path}`).digest();
  const n = 512 + (seed.readUInt16BE(0) % 4096);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i += 32) createHash("sha256").update(seed).update(String(i)).digest().copy(out, i);
  return out;
}

const fakeRevision = (id: string) => createHash("sha1").update(id).digest("hex");
const slug = (id: string) =>
  id
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
const tagOf = (m: HostedModel) => m.hosting?.tag ?? `models-${slug(m.id)}`;

/** The paths a model would have once pinned, when the registry has none yet. */
function guessPaths(m: HostedModel): Array<Pick<HostedFile, "path" | "cache" | "key">> {
  const h = m.hosting!;
  if (h.cache === "webllm/model") {
    const lib = h.lib ? [{ path: `lib/${h.lib.split("/").pop()}`, key: h.lib, cache: "webllm/wasm" }] : [];
    return [{ path: "mlc-chat-config.json", cache: "webllm/config" }, { path: "tokenizer.json" }, { path: "params_shard_0.bin" }, ...lib];
  }
  const dtype = h.dtypes?.[0] ?? "q8";
  const suffix: Record<string, string> = { fp32: "", fp16: "_fp16", q8: "_quantized", q4: "_q4", q4f16: "_q4f16" };
  return [{ path: "config.json" }, { path: `onnx/model${suffix[dtype] ?? ""}.onnx` }];
}

/** The synthetic registry and the mirror's files (`<tag>/<path>` → bytes). */
export function syntheticMirror(models: HostedModel[]): { models: HostedModel[]; files: Map<string, Buffer>; converted: string[] } {
  const files = new Map<string, Buffer>();
  const out: HostedModel[] = [];
  const converted: string[] = [];
  for (const m of models.filter(isDefault)) {
    if (!m.hosting) continue;
    if (m.hosting.via === "converted") {
      converted.push(m.id);
      continue;
    }
    const hosting = { ...m.hosting, revision: m.hosting.hf ? fakeRevision(m.id) : m.hosting.revision, unpinned: undefined };
    const copy: HostedModel = { ...m, hosting };
    const tag = tagOf(copy);
    const paths = m.files?.length ? m.files.map((f) => ({ path: f.path, cache: f.cache, key: f.key })) : guessPaths(m);
    copy.files = paths.map((p) => {
      const data = syntheticBytes(tag, p.path);
      files.set(`${tag}/${p.path}`, data);
      return { path: p.path, sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length, ...(p.cache ? { cache: p.cache } : {}), ...(p.key ? { key: p.key } : {}) };
    });
    out.push(copy);
  }
  return { models: out, files, converted };
}

export interface ScenarioArgs {
  /** The module to import in the page: "/src/ai/modelHosting.ts" on the dev server. */
  modulePath: string;
  mirror: string;
  models: HostedModel[];
}

export interface ScenarioResult {
  id: string;
  kinds?: string[];
  inCache?: number;
  files?: number;
  error?: string;
}

/**
 * Runs in the page (self-contained: page.evaluate sends its source): load
 * every model through the source chain, then read each file back from the
 * cache its library reads.
 */
export async function mirrorScenario(args: ScenarioArgs): Promise<ScenarioResult[]> {
  type H = {
    ensureModelFiles(m: unknown, deps: unknown): Promise<{ fetched: Array<{ kind: string }>; skipped: number }>;
    cacheNameFor(m: unknown, f: unknown): string | null;
    libraryKey(m: unknown, f: unknown): string | null;
  };
  const h = (await import(/* @vite-ignore */ args.modulePath)) as H;
  const out: ScenarioResult[] = [];
  for (const m of args.models) {
    try {
      const rep = await h.ensureModelFiles(m, { fetch: (u: string, i?: RequestInit) => fetch(u, i), sources: { mirror: args.mirror, user: null }, open: (n: string) => caches.open(n) });
      let inCache = 0;
      for (const f of m.files ?? []) {
        const name = h.cacheNameFor(m, f);
        const key = h.libraryKey(m, f);
        if (!name || !key) continue;
        const res = await (await caches.open(name)).match(key);
        if (res && (await res.arrayBuffer()).byteLength === f.bytes) inCache++;
      }
      out.push({ id: m.id, kinds: rep.fetched.map((x) => x.kind), inCache, files: m.files?.length ?? 0 });
    } catch (e) {
      out.push({ id: m.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
