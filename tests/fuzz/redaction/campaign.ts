/**
 * One fuzz night (plan W8.8): every generator, a seed named by the date, a
 * leak minimised and turned into a regression case. The oracle is passed in,
 * so this file needs no DOM and its logic is tested on its own.
 */
import { GENERATORS, generatorSeed, type Generator } from "./generators";

export interface Oracle {
  /** `leaked`: the tokens the preview shades and the export keeps (empty: safe); `shaded`: how many it shades. */
  check(md: string): { leaked: string[]; shaded: number };
}

export interface Found {
  generator: Generator["id"];
  seed: number;
  /** The case's index in its generator's stream for that seed. */
  index: number;
  md: string;
  /** The smallest note (by deleting lines, then runs of text) that still leaks. */
  min: string;
  leaked: string[];
}

export interface CampaignResult {
  night: number;
  cases: number;
  shaded: number;
  /** Cases where the preview or the export threw (reported, never hidden). */
  threw: Array<{ generator: Generator["id"]; index: number; error: string }>;
  perGenerator: Record<string, { cases: number; shaded: number; leaking: number }>;
  found: Found[];
}

/** Deletes lines, then whitespace-separated runs, while the note still leaks. Deterministic. */
export function minimise(md: string, stillLeaks: (md: string) => boolean, budget = 4000): string {
  let calls = 0;
  const tryIt = (s: string) => calls++ < budget && stillLeaks(s);
  let lines = md.split("\n");
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < lines.length; i++) {
      const next = lines.slice(0, i).concat(lines.slice(i + 1));
      if (tryIt(next.join("\n"))) {
        lines = next;
        changed = true;
        i--;
      }
    }
  }
  let text = lines.join("\n");
  for (let changed = true; changed; ) {
    changed = false;
    const parts = text.split(/([ \t\n])/);
    for (let i = 0; i < parts.length; i += 2) {
      if (!parts[i]) continue;
      const next = parts.slice(0, i).concat(parts.slice(i + 2)).join("");
      if (tryIt(next)) {
        text = next;
        changed = true;
        break;
      }
    }
  }
  const trimmed = text.replace(/[ \t]+$/gm, "");
  return trimmed !== text && tryIt(trimmed) ? trimmed : text;
}

export interface CampaignOptions {
  night: number;
  /** Cases in all, split evenly across the generators. */
  n: number;
  oracle: Oracle;
  generators?: readonly Generator[];
  /** Minimise at most this many leaks per generator (each costs many oracle calls). */
  minimiseLimit?: number;
}

export function runCampaign({ night, n, oracle, generators = GENERATORS, minimiseLimit = 5 }: CampaignOptions): CampaignResult {
  const result: CampaignResult = { night, cases: 0, shaded: 0, threw: [], perGenerator: {}, found: [] };
  const per = Math.ceil(n / generators.length);
  generators.forEach((g, gi) => {
    const seed = generatorSeed(night, gi);
    const next = g.stream(seed);
    const stats = { cases: 0, shaded: 0, leaking: 0 };
    for (let index = 0; index < per; index++) {
      const md = next();
      stats.cases++;
      try {
        const { leaked, shaded } = oracle.check(md);
        stats.shaded += shaded;
        if (!leaked.length) continue;
        stats.leaking++;
        const min = stats.leaking <= minimiseLimit ? minimise(md, (s) => oracle.check(s).leaked.length > 0) : md;
        result.found.push({ generator: g.id, seed, index, md, min, leaked: oracle.check(min).leaked });
      } catch (e) {
        result.threw.push({ generator: g.id, index, error: String(e).slice(0, 200) });
      }
    }
    result.perGenerator[g.id] = stats;
    result.cases += stats.cases;
    result.shaded += stats.shaded;
  });
  return result;
}

// ------------------------------------------------------------ regressions

export interface Regression {
  /** `rdx-` and the FNV-1a hash of `md`: the same leak found twice is one case. */
  id: string;
  /** The UTC date it was found (YYYY-MM-DD), or the review that found it. */
  found: string;
  generator: string;
  seed?: number;
  index?: number;
  md: string;
  /** The tokens it leaked when found (the regression test asserts none now). */
  leaked: string[];
  /**
   * Set while the leak is not fixed yet: the finding's name. The regression
   * test then asserts it STILL leaks, so a fix has to remove this field (and
   * the case stays a test); nothing is silently skipped.
   */
  open?: string;
}

export interface RegressionFile {
  about: string;
  cases: Regression[];
}

export function regressionId(md: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < md.length; i++) {
    h ^= md.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return "rdx-" + h.toString(16).padStart(8, "0");
}

export function nightDate(night: number): string {
  const s = String(night);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

export function toRegression(f: Found, night: number): Regression {
  return { id: regressionId(f.min), found: nightDate(night), generator: f.generator, seed: f.seed, index: f.index, md: f.min, leaked: f.leaked };
}

/** Adds the new cases that are not there yet; the order is stable (by id), so the file diffs cleanly. */
export function mergeRegressions(file: RegressionFile, add: readonly Regression[]): { file: RegressionFile; added: Regression[] } {
  const have = new Set(file.cases.map((c) => c.id));
  const added: Regression[] = [];
  for (const c of add) {
    if (have.has(c.id)) continue;
    have.add(c.id);
    added.push(c);
  }
  const cases = [...file.cases, ...added].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { file: { ...file, cases }, added };
}
