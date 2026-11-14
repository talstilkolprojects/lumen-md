/**
 * Writing measured numbers into models/registry.json (plan 7.8). Each
 * model entry gets `measured.<device>` — the latest full run of the
 * benchmark on that device. A run is written only when it is real and
 * whole: no error, every item of every part, not limited, a model (not a
 * baseline), and on the device it was asked for (a WebGPU run that fell
 * back to WebAssembly, or ran on SwiftShader, is not a WebGPU number).
 */

/** Why a result may not be written, or null when it may. */
export function refusal(r, env = {}) {
  if (r.status !== "measured") return `status ${r.status}`;
  if (!r.models.length) return "a baseline, not a model";
  if (r.limited) return "--limit: not every item";
  if (r.backend === "webgpu" && r.device !== "webgpu") return `asked for WebGPU, ran on ${r.device}`;
  // Headless Chromium without a GPU offers WebGPU on SwiftShader, a CPU emulation: not a GPU number.
  if (r.device === "webgpu" && isSoftwareAdapter(env)) return "WebGPU on a software adapter (SwiftShader), not a GPU";
  if (!r.quality || !Object.keys(r.quality).length) return "no quality score";
  return null;
}

/** SwiftShader (or another CPU fallback adapter) behind navigator.gpu. */
export function isSoftwareAdapter(env) {
  const a = env?.adapter;
  return !!a && /swiftshader|software|llvmpipe|lavapipe/i.test(`${a.vendor} ${a.architecture} ${a.description}`);
}

/** The record stored for one model and device. */
export function record(r, env) {
  return {
    at: r.at,
    tool: "npm run bench:models",
    set: r.set,
    split: r.split,
    items: r.items,
    gpu: env.adapter ? [env.adapter.vendor, env.adapter.architecture, env.adapter.description].filter(Boolean).join(" ") || null : null,
    browser: (/(?:HeadlessChrome|Chrome|Chromium)\/[\d.]+/.exec(env.userAgent) ?? [null])[0],
    loadMs: r.loadMs,
    prepareMs: r.prepareMs,
    p50Ms: r.p50Ms,
    p95Ms: r.p95Ms,
    rssPeakMB: r.rssPeakMB,
    rssDeltaMB: r.rssDeltaMB,
    jsHeapPeakMB: r.jsHeapPeakMB,
    quality: r.quality,
  };
}

/** → { registry (a new object), written: [{ model, device, engine }], skipped: [{ engine, backend, reason }] } */
export function applyMeasurements(registry, results, env) {
  const next = structuredClone(registry);
  const written = [];
  const skipped = [];
  for (const r of results) {
    const why = refusal(r, r.env ?? env);
    if (why) {
      skipped.push({ engine: r.engine, backend: r.backend, reason: why });
      continue;
    }
    for (const id of r.models) {
      const m = next.models.find((x) => x.id === id);
      if (!m) {
        skipped.push({ engine: r.engine, backend: r.backend, reason: `${id} is not in models/registry.json` });
        continue;
      }
      m.measured = { ...(m.measured ?? {}), [r.device]: record(r, r.env ?? env) };
      written.push({ model: id, device: r.device, engine: r.engine });
    }
  }
  return { registry: next, written, skipped };
}
