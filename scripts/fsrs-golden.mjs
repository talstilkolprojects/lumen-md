#!/usr/bin/env node
/**
 * Golden scheduling results from ts-fsrs for the 50 scenarios (plan W3.3),
 * written to src/__tests__/fixtures/fsrs-golden.json; the test
 * src/__tests__/fsrsGolden.test.ts then checks Lumen's scheduler against
 * them step by step. ts-fsrs is not a dependency of the app: install it for
 * this run only.
 *
 *   npm install --no-save ts-fsrs@4
 *   node scripts/fsrs-golden.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { makeScenarios, simulate } from "./lib/fsrs-scenarios.mjs";

let ts;
try {
  ts = await import("ts-fsrs");
} catch {
  console.error("ts-fsrs is not installed. Run: npm install --no-save ts-fsrs@4");
  process.exit(1);
}
const STATES = ["new", "learning", "review", "relearning"];
const f = ts.fsrs(ts.generatorParameters({ enable_fuzz: false, enable_short_term: true, request_retention: 0.9, maximum_interval: 36500 }));
const adapter = {
  create: (now) => ts.createEmptyCard(now),
  next: (card, rating, now) => f.next(card, now, rating).card,
  read: (c) => ({ state: STATES[c.state], due: new Date(c.due).toISOString(), stability: c.stability, difficulty: c.difficulty, scheduledDays: c.scheduled_days, last: c.last_review ? new Date(c.last_review).toISOString() : null }),
};
const scenarios = makeScenarios();
const out = { generator: `ts-fsrs ${ts.default_w ? "(default_w " + ts.default_w.length + " weights)" : ""}`.trim(), w: ts.default_w ? [...ts.default_w] : null, scenarios: scenarios.map((s) => ({ id: s.id, steps: s.steps, records: simulate(s, adapter) })) };
const path = new URL("../src/__tests__/fixtures/fsrs-golden.json", import.meta.url);
mkdirSync(new URL(".", path), { recursive: true });
writeFileSync(path, JSON.stringify(out, null, 1) + "\n");
console.log(`written: src/__tests__/fixtures/fsrs-golden.json (${out.scenarios.length} scenarios, ${out.scenarios.reduce((n, s) => n + s.records.length, 0)} reviews)`);
