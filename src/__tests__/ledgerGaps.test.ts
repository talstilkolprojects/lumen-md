/**
 * Plan W6.29: every network call goes through the privacy ledger.
 *
 * `npm run pr:check` checks the lines a PR adds. This test checks every line of
 * production source with the same rule (scripts/lib/prGate.mjs,
 * unregisteredNetworkCalls): a fetch, fetchWithRetry, XMLHttpRequest, WebSocket,
 * EventSource, sendBeacon or importScripts call must name a host the ledger knows,
 * or carry `// privacy-ledger: <the rule that records it>` on its line or the two
 * above.
 *
 * The calls that were already there before W6.29 are listed in
 * fixtures/ledger-gaps-baseline.json. That list only goes down: a call that is not
 * in it fails here, and so does a listed call that is gone (delete its line).
 * @vitest-environment node
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isProductionSource,
  unregisteredNetworkCalls,
  // @ts-expect-error -- plain .mjs script, no types (as in prGate.test.ts)
} from "../../scripts/lib/prGate.mjs";

const root = join(__dirname, "..", "..");
const ledger = readFileSync(join(root, "src", "ai", "privacyLedger.ts"), "utf8");
const baseline = (JSON.parse(readFileSync(join(__dirname, "fixtures", "ledger-gaps-baseline.json"), "utf8")) as { calls: string[] }).calls;

type Lines = Record<string, Array<{ line: number; text: string; before: string[] }>>;

/** Every line of each file, with the two lines above it (what the rule reads). */
function allLines(files: Record<string, string>): Lines {
  const out: Lines = {};
  for (const [file, src] of Object.entries(files)) {
    const lines = src.split("\n");
    out[file] = lines.map((text, i) => ({ line: i + 1, text, before: lines.slice(Math.max(0, i - 2), i) }));
  }
  return out;
}

/** Production files under src/, from the disk (a new file counts before it is committed; builds may have no .git). */
function productionFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (isProductionSource(rel)) out[rel] = readFileSync(join(root, rel), "utf8");
    }
  };
  walk("src");
  return out;
}

/** a minus b, as multisets. */
function minus(a: string[], b: string[]): string[] {
  const left = new Map<string, number>();
  for (const x of b) left.set(x, (left.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of a) {
    const n = left.get(x) ?? 0;
    if (n > 0) left.set(x, n - 1);
    else out.push(x);
  }
  return out;
}

describe("every network call in the app goes through the privacy ledger (W6.29)", () => {
  const found = unregisteredNetworkCalls(allLines(productionFiles()), ledger).map((v: { file: string; text: string }) => `${v.file} | ${v.text.trim()}`);

  it("no call outside the ledger that is not on the baseline", () => {
    // A new call: route it through the ledger, or add `// privacy-ledger: <rule>` above it.
    expect(minus(found, baseline)).toEqual([]);
  });

  it("the baseline only lists calls that are still there (it only goes down)", () => {
    // A listed call was annotated, routed or removed: delete its line from the baseline.
    expect(minus(baseline, found)).toEqual([]);
  });
});

describe("the rule catches each kind of call (self-test)", () => {
  const planted: Array<[string, string]> = [
    ["fetch", "  const r = await fetch(url);"],
    ["fetchWithRetry", "  const r = await fetchWithRetry(endpoint, {}, { label: \"x\" });"],
    ["XMLHttpRequest", "  const x = new XMLHttpRequest();"],
    ["WebSocket", "  const ws = new WebSocket(serverUrl);"],
    ["EventSource", "  const es = new EventSource(streamUrl);"],
    ["sendBeacon", "  navigator.sendBeacon(reportUrl, body);"],
    ["importScripts", "  importScripts(workerUrl);"],
    ["an unknown host", '  await fetch("https://tracker.example.net/collect");'],
  ];

  for (const [kind, line] of planted) {
    it(`a new ${kind} without a note fails`, () => {
      const v = unregisteredNetworkCalls(allLines({ "src/new/feature.ts": `export async function go() {\n${line}\n}\n` }), ledger);
      expect(v.map((x: { line: number }) => x.line)).toEqual([2]);
    });

    it(`the same ${kind} with a note passes`, () => {
      if (kind === "an unknown host") return; // a literal host must be in the ledger: a note doesn't cover it
      const src = `export async function go() {\n  // privacy-ledger: research — the research endpoint rule\n${line}\n}\n`;
      expect(unregisteredNetworkCalls(allLines({ "src/new/feature.ts": src }), ledger)).toEqual([]);
    });
  }

  it("a host the ledger knows passes without a note; tests are not production source", () => {
    expect(unregisteredNetworkCalls(allLines({ "src/new/a.ts": 'await fetch("https://api.openai.com/v1/models");' }), ledger)).toEqual([]);
    expect(unregisteredNetworkCalls(allLines({ "src/__tests__/a.test.ts": "await fetch(url);" }), ledger)).toEqual([]);
  });
});
