/**
 * The browser's memory during a run (plan 7.8): the resident size of the
 * whole Chromium process tree (page, workers, GPU process), sampled with
 * `ps`. Not on Windows (null there). GPU memory itself is not visible to
 * a page; the GPU process's resident size is the closest number.
 */
import { execFileSync } from "node:child_process";

/** Resident MB of `pid` and all its descendants, or null when `ps` is not available. */
export function treeRssMB(pid) {
  if (process.platform === "win32" || !pid) return null;
  let out;
  try {
    out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" });
  } catch {
    return null;
  }
  const kids = new Map();
  const rss = new Map();
  for (const line of out.trim().split("\n")) {
    const [p, pp, r] = line.trim().split(/\s+/).map(Number);
    rss.set(p, r);
    kids.set(pp, [...(kids.get(pp) ?? []), p]);
  }
  let kb = 0;
  const stack = [pid];
  const seen = new Set();
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    kb += rss.get(p) ?? 0;
    stack.push(...(kids.get(p) ?? []));
  }
  return Math.round((kb / 1024) * 10) / 10;
}

/** Sample every `ms` until stop(); → { baselineMB, peakMB } (nulls without ps). */
export function sampleMemory(pid, ms = 250) {
  const baselineMB = treeRssMB(pid);
  let peakMB = baselineMB;
  const timer = setInterval(() => {
    const v = treeRssMB(pid);
    if (v != null && (peakMB == null || v > peakMB)) peakMB = v;
  }, ms);
  return {
    stop() {
      clearInterval(timer);
      const v = treeRssMB(pid);
      if (v != null && (peakMB == null || v > peakMB)) peakMB = v;
      return { baselineMB, peakMB };
    },
  };
}
