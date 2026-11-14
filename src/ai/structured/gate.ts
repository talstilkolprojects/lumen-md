/**
 * The gate for the "zero download" tier (plan W7.14): Chrome's built-in
 * model takes short tasks only after its Hebrew eval scored at least 90 %
 * of the current local model's score on the same cases (conformance.ts →
 * `runGateEval`). The result is kept per browser with the Chrome version
 * it was measured on; a new Chrome version needs a new measurement.
 */
export const GATE_KEY = "lumen.ai.builtinGate";
export const GATE_RATIO = 0.9;

export interface GateResult {
  builtinScore: number;
  localScore: number;
  localModel: string;
  chromeVersion: string;
  at: string;
}

type Store = Pick<Storage, "getItem" | "setItem">;
const ls = (): Store | null => (typeof localStorage === "undefined" ? null : localStorage);

export function chromeVersion(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  return /Chrome\/(\d+)/.exec(ua)?.[1] ?? "";
}

export function readGate(store: Store | null = ls()): GateResult | null {
  try {
    const v = JSON.parse(store?.getItem(GATE_KEY) ?? "null") as GateResult | null;
    return v && typeof v.builtinScore === "number" && typeof v.localScore === "number" ? v : null;
  } catch {
    return null;
  }
}

export function saveGate(r: GateResult, store: Store | null = ls()): void {
  try {
    store?.setItem(GATE_KEY, JSON.stringify(r));
  } catch {
    /* blocked storage: the gate stays closed */
  }
}

/** Open when a measurement on this Chrome version reached ≥ 90 % of the local model's score. */
export function builtinGateOpen(store: Store | null = ls(), version: string = chromeVersion()): boolean {
  const g = readGate(store);
  if (!g || !(g.localScore > 0) || (version && g.chromeVersion !== version)) return false;
  return g.builtinScore >= GATE_RATIO * g.localScore;
}
