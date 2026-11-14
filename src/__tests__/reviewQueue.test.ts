/**
 * Plan W6.13: the weekly sensitive-review queue (scripts/lib/reviewQueue.mjs)
 * — at most five PRs that touch .github/CODEOWNERS paths and still need a
 * person, riskiest area first, each with its questions, attack cases and the
 * tests that cover the changed modules.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error -- plain .mjs script, no types
import { AREAS, buildQueue } from "../../scripts/lib/reviewQueue.mjs";

const OWNERS = readFileSync(join(__dirname, "../../.github/CODEOWNERS"), "utf8");
const NOW = Date.parse("2026-11-14T12:00:00Z");
const pr = (number: number, files: string[], over: Record<string, unknown> = {}) => ({
  number,
  title: `PR ${number}`,
  author: "agent",
  base: "verify/train-2",
  draft: true,
  createdAt: "2026-11-10T12:00:00Z",
  labels: [],
  events: [],
  reviews: [],
  headSha: "h" + number,
  headDate: "2026-11-10T12:00:00Z",
  files: files.map((filename) => ({ filename, additions: 10, deletions: 2 })),
  ...over,
});

describe("sensitive review queue (W6.13)", () => {
  it("every CODEOWNERS section has an area with questions and attack cases", () => {
    const sections = [...OWNERS.matchAll(/^#\s*──\s*(.+?)\s*──/gm)].map((m) => m[1]);
    expect(sections.length).toBeGreaterThan(5);
    for (const s of sections) {
      const a = (AREAS as { key: string; ask: string; attacks: string[] }[]).find((x) => s.startsWith(x.key));
      expect(a, s).toBeDefined();
      expect(a!.ask.length).toBeGreaterThan(20);
      expect(a!.attacks.length).toBeGreaterThan(0);
    }
  });

  it("keeps PRs with no sensitive file out, and takes at most five, cryptography first", () => {
    const prs = [
      pr(1, ["src/ui/Button.tsx"]),
      pr(2, ["public/_headers"]),
      pr(3, ["src/sync/e2ee/kdf.ts"], { createdAt: "2026-11-13T12:00:00Z" }),
      pr(4, ["src/storage/vault/write.ts"]),
      pr(5, ["src/ai/privacyLedger.ts"]),
      pr(6, ["src-tauri/capabilities/default.json"]),
      pr(7, ["src/lib/markupSanitizer.ts"]),
      pr(8, ["src/share/link.ts"]),
    ];
    const q = buildQueue({ prs, codeowners: OWNERS, now: NOW, owner: "talstilkol" });
    expect(q.waiting).toBe(7);
    expect(q.items).toHaveLength(5);
    expect(q.items[0].pr.number).toBe(3);
    expect(q.items.map((i: { pr: { number: number } }) => i.pr.number)).not.toContain(1);
    expect(q.markdown).toMatch(/## 1\. #3 PR 3/);
    expect(q.markdown).toMatch(/cryptography: an independent reviewer/);
    expect(q.markdown).toMatch(/- \[ \] Flip one byte of the ciphertext/);
    expect(q.markdown).toMatch(/npm run pr:check -- --base origin\/verify\/train-2 --pr 3 --no-size/);
  });

  it("drops a PR a person reviewed after its last commit, but not a crypto PR the owner labelled", () => {
    const labelled = (actor: string) => ({ labels: ["human-reviewed"], events: [{ event: "labeled", label: "human-reviewed", created_at: "2026-11-11T12:00:00Z", actor }] });
    const q = buildQueue({ prs: [pr(10, ["public/_headers"], labelled("talstilkol")), pr(11, ["src/sync/e2ee/kdf.ts"], labelled("talstilkol")), pr(12, ["src/sync/e2ee/kdf.ts"], labelled("maintainer2"))], codeowners: OWNERS, now: NOW, owner: "talstilkol" });
    expect(q.reviewed).toBe(2);
    expect(q.items.map((i: { pr: { number: number } }) => i.pr.number)).toEqual([11]);
    expect(q.items[0].why).toMatch(/neither the repository owner nor the author/);
  });

  it("names the tests that import the changed modules", () => {
    const q = buildQueue({ prs: [pr(20, ["src/sync/e2ee/kdf.ts"])], codeowners: OWNERS, now: NOW, tests: { "src/sync/e2ee/kdf": ["src/__tests__/e2eeCrypto.test.ts"] } });
    expect(q.markdown).toContain("npx vitest run src/__tests__/e2eeCrypto.test.ts");
    const none = buildQueue({ prs: [pr(21, ["src/storage/vault/x.ts"])], codeowners: OWNERS, now: NOW });
    expect(none.markdown).toMatch(/No test in src\/__tests__ names these modules/);
  });

  it("an empty queue says so", () => {
    expect(buildQueue({ prs: [], codeowners: OWNERS, now: NOW }).markdown).toContain("Nothing waits.");
  });
});
