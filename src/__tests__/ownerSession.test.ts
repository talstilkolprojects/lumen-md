// @vitest-environment node
/**
 * Plan W6.20 — one command per owner session that runs, checks and records:
 * scripts/owner/{steps,session,collect,receipt}.mjs.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// @ts-expect-error — plain .mjs script without type declarations
import { STEPS, SESSIONS, secretLooking } from "../../scripts/owner/steps.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { OFF_LIST, loadState, receiptPath, runChecks, runStep, statusLines } from "../../scripts/owner/session.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { assign, collect, itemsOf, normalise, ownerSections } from "../../scripts/owner/collect.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { check, seal } from "../../scripts/owner/receipt.mjs";

type Obj = Record<string, any>;
const ROOT = resolve(__dirname, "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "lumen-owner-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), pub: publicKey.export({ type: "spki", format: "pem" }).toString() };
}
/** An independent copy of #455's canonical form, to pin the bytes. */
function canon(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canon(x))).join(",")}]`;
  const o = v as Obj;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
    .join(",")}}`;
}

/** A context with no network: every answer comes from the maps given. */
function fakeCtx(over: Obj = {}) {
  const files: Record<string, string> = over.files ?? {};
  return {
    env: over.env ?? {},
    root: "/repo",
    ran: {} as Record<string, number>,
    path: (p: string) => (p.startsWith("~/") ? `/home/tal/${p.slice(2)}` : p.startsWith("/") ? p : `/repo/${p}`),
    exists: (p: string) => p in files || Object.keys(files).some((f) => f.startsWith(`${p}/`)),
    read: (p: string) => files[p],
    mode: () => 0o600,
    mkdirp: () => undefined,
    list: (p: string) => Object.keys(files).filter((f) => f.startsWith(`${p}/`)).map((f) => f.slice(p.length + 1)),
    which: (c: string) => (over.which ?? []).includes(c),
    exec: async (cmd: string, args: string[]) => (over.exec ? over.exec(cmd, args) : { status: 0, stdout: "", stderr: "" }),
    gh: async (p: string) => over.gh?.[p] ?? { status: 404, json: null },
    fetch: async (u: string) => over.fetch?.[u.split("?")[0]] ?? { status: 0, json: null, text: "" },
  };
}

describe("receipts", () => {
  it("seal is byte-compatible with #455/#511: sha256 + Ed25519 over the canonical JSON without `receipt`", () => {
    const k = keys();
    const r = seal({ kind: "owner", step: "accounts/github", b: [1, { z: 1, a: 2 }], a: "x" }, k.priv);
    const { receipt, ...rest } = r;
    const text = canon(rest);
    expect(receipt.sha256).toBe(createHash("sha256").update(text).digest("hex"));
    expect(verify(null, Buffer.from(text), createPublicKey(k.pub), Buffer.from(receipt.signature, "base64"))).toBe(true);
    expect(receipt.key).toBe(createHash("sha256").update(createPublicKey(k.pub).export({ type: "spki", format: "pem" }).toString()).digest("hex").slice(0, 16));
    expect(check(r, k.pub).ok).toBe(true);
  });

  it("refuses a changed receipt and another key", () => {
    const k = keys();
    const r = seal({ kind: "owner", done: false }, k.priv);
    expect(check({ ...r, done: true }, k.pub).ok).toBe(false);
    expect(check(r, keys().pub).ok).toBe(false);
    const forged = { ...r, receipt: { ...r.receipt, signature: sign(null, Buffer.from("x"), generateKeyPairSync("ed25519").privateKey).toString("base64") } };
    expect(check(forged, k.pub).ok).toBe(false);
  });
});

describe("the steps", () => {
  it("are at most 15 owner items in the three sessions, each with an automatic check (W6.20 acceptance)", () => {
    expect(STEPS.length).toBeLessThanOrEqual(15);
    expect(new Set(STEPS.map((s: Obj) => s.id)).size).toBe(STEPS.length);
    for (const s of STEPS) {
      expect(Object.keys(SESSIONS)).toContain(s.session);
      expect(s.id.startsWith(`${s.session}/`)).toBe(true);
      expect(s.checks.some((c: Obj) => c.auto)).toBe(true);
      expect(new Set(s.checks.map((c: Obj) => c.id)).size).toBe(s.checks.length);
      expect(s.do.en.length).toBe(s.do.he.length);
      for (const c of s.checks) expect(c.en && c.he).toBeTruthy();
    }
  });

  it("keep the step and check ids the W6.44 board reads", () => {
    const has = (step: string, id: string) => STEPS.find((s: Obj) => s.id === step)?.checks.some((c: Obj) => c.id === id);
    expect(has("accounts/github", "private-vulnerability-reporting")).toBe(true);
    expect(has("accounts/github", "secret-scanning")).toBe(true);
    expect(has("accounts/hosts", "signaling")).toBe(true);
    expect(has("devices/manual-checks", "word-rtl")).toBe(true);
    expect(has("devices/manual-checks", "share-sheet")).toBe(true);
    expect(has("devices/desktop-release", "update-drill")).toBe(true);
  });

  it("start session 1 with #432, W6.10 and W6.12", () => {
    const first = STEPS.find((s: Obj) => s.session === "accounts");
    expect(first.id).toBe("accounts/github");
    expect(first.plan.includes("W6.10") && first.plan.includes("W6.12")).toBe(true);
    expect(first.prs).toContain(432);
  });

  it("carry every plan owner item (15.x) or list why it is off the list", () => {
    const plan = JSON.parse(readFileSync(join(ROOT, "plan/plan.json"), "utf8"));
    const carried = new Set(STEPS.flatMap((s: Obj) => s.plan));
    for (const o of plan.owner ?? []) expect(carried.has(o.id) || o.id in OFF_LIST).toBe(true);
  });

  it("flag secret-looking VITE_ names, not the public ones", () => {
    expect(secretLooking("VITE_OPENAI_API_KEY")).toBe(true);
    expect(secretLooking("VITE_HF_TOKEN")).toBe(true);
    expect(secretLooking("VITE_DROPBOX_APP_KEY")).toBe(false);
    expect(secretLooking("HF_TOKEN")).toBe(false);
  });
});

describe("checks", () => {
  const github = STEPS.find((s: Obj) => s.id === "accounts/github");
  it("read GitHub's answers, and say 'cannot check' without a token", async () => {
    const ctx = fakeCtx({
      gh: {
        "repos/talstilkol/lumen-md/pulls/432": { status: 200, json: { merged: true } },
        "repos/talstilkol/lumen-md/labels/human-reviewed": { status: 200, json: {} },
        "repos/talstilkol/lumen-md/private-vulnerability-reporting": { status: 200, json: { enabled: true } },
        "repos/talstilkol/lumen-md": { status: 200, json: { security_and_analysis: { secret_scanning: { status: "enabled" }, secret_scanning_push_protection: { status: "disabled" } } } },
      },
    });
    const r = Object.fromEntries((await runChecks(github, ctx)).map((c: Obj) => [c.id, c.ok]));
    expect(r).toEqual({ "merged-432": true, label: true, "private-vulnerability-reporting": true, "secret-scanning": false, "ignored-build-step": null });
  });

  it("ask Vercel's REST API with the token for the Ignored Build Step", async () => {
    const ctx = fakeCtx({ env: { VERCEL_TOKEN: "t" }, fetch: { "https://api.vercel.com/v9/projects/lumen-md": { status: 200, json: { commandForIgnoringBuildStep: "bash scripts/vercel-ignore.sh" } } } });
    const c = (await runChecks(github, ctx)).find((x: Obj) => x.id === "ignored-build-step");
    expect(c.ok).toBe(true);
  });

  it("check the Kaggle token file's permissions before using it", async () => {
    const step = STEPS.find((s: Obj) => s.id === "accounts/test-clouds");
    const ctx = { ...fakeCtx({ files: { "/home/tal/.kaggle/kaggle.json": JSON.stringify({ username: "tal", key: "k" }) }, fetch: { "https://www.kaggle.com/api/v1/kernels/list": { status: 200, json: [] } } }), mode: () => 0o644 };
    expect((await runChecks(step, ctx)).find((x: Obj) => x.id === "kaggle").ok).toBe(false);
    const ok = { ...ctx, mode: () => 0o600 };
    expect((await runChecks(step, ok)).find((x: Obj) => x.id === "kaggle").ok).toBe(true);
  });
});

describe("a session step", () => {
  const k = keys();
  const step = STEPS.find((s: Obj) => s.id === "gpu/archives");
  const io = (answers: string[]) => {
    const said: string[] = [];
    return { said, say: (t: string) => said.push(t), ask: async () => answers.shift() ?? "" };
  };
  let t = Date.parse("2026-11-13T09:00:00Z");
  const now = () => new Date((t += 5 * 60_000));

  it("prints the browser steps, checks, asks the attestations and seals a receipt", async () => {
    const o = io(["", "y", "y", "n"]);
    const ctx = fakeCtx({ env: { ZOTERO_API_KEY: "z" }, fetch: { "https://api.zotero.org/keys/z": { status: 200, json: { userID: 7 } } } });
    const r = await runStep(step, ctx, o, { now, key: k.priv, commit: { sha: "a".repeat(40), branch: "main" } });
    expect(o.said.join("\n")).toContain("zotero.org");
    expect(check(r, k.pub).ok).toBe(true);
    expect(r.kind).toBe("owner");
    expect(r.step).toBe("gpu/archives");
    expect(r.done).toBe(false);
    expect(r.checks.find((c: Obj) => c.id === "zotero").ok).toBe(false);
    expect(r.checks.find((c: Obj) => c.id === "mail").attested).toBe(true);
    expect(r.minutes).toEqual({ estimated: 30, actual: 5 });
  });

  it("resumes: a second run adds its minutes and closes the step", async () => {
    const dir = join(tmp, "owner");
    mkdirSync(join(dir, "gpu"), { recursive: true });
    writeFileSync(join(dir, "PUBLIC_KEY.pem"), k.pub);
    const ctx = fakeCtx({ env: { ZOTERO_API_KEY: "z" }, fetch: { "https://api.zotero.org/keys/z": { status: 200, json: { userID: 7 } } } });
    const first = await runStep(step, ctx, io(["", "y", "y", "n"]), { now, key: k.priv });
    writeFileSync(receiptPath(dir, step.id), JSON.stringify(first));
    const { state } = loadState(dir);
    expect(state[step.id].done).toBe(false);
    const second = await runStep(step, ctx, io(["", "y", "y", "y"]), { now, key: k.priv, previous: state[step.id] });
    expect(second.done).toBe(true);
    expect(second.minutes.actual).toBe(10);
    expect(second.startedAt).toBe(first.startedAt);
    writeFileSync(receiptPath(dir, step.id), JSON.stringify(second));
    expect(statusLines(loadState(dir).state).join("\n")).toMatch(/✓ gpu\/archives/);
  });

  it("ignores a receipt changed by hand", () => {
    const dir = join(tmp, "owner");
    const r = JSON.parse(readFileSync(receiptPath(dir, step.id), "utf8"));
    writeFileSync(receiptPath(dir, step.id), JSON.stringify({ ...r, minutes: { estimated: 30, actual: 1 } }));
    const { state, bad } = loadState(dir);
    expect(state[step.id]).toBeUndefined();
    expect(bad.length).toBe(1);
  });

  it("runs an action only after a yes, and skips one whose result already exists", async () => {
    const signing = STEPS.find((s: Obj) => s.id === "accounts/signing");
    const calls: string[] = [];
    const ctx = fakeCtx({ files: { "/home/tal/.tauri/lumen-updater.key": "x" }, exec: (c: string, a: string[]) => (calls.push([c, ...a].join(" ")), { status: 0, stdout: "" }) });
    const o = io(["y", "", "n", "n", "n"]);
    await runStep(signing, ctx, o, { now, key: k.priv });
    expect(o.said.join("\n")).toContain("already there");
    expect(calls.some((c) => c.startsWith("npx tauri signer"))).toBe(false);
    expect(o.said.join("\n")).toContain("is not in this checkout"); // the release key's script (#492)
    expect(calls.filter((c) => c.startsWith("keytool")).length).toBe(1);
  });
});

describe("collecting owner commands from PR bodies", () => {
  const body = (s: string) => `## What\n\ntext\n\n${s}\n\n## Local verification\n\n- none`;
  const prs = [
    { number: 1, title: "a", body: body("## Owner commands\n\n```sh\n# 1. the label\ngh label create human-reviewed --repo x\nnpx wrangler@4.20.0 login   # once\n```\n- Open `npm run models:day` on the Mac.") },
    { number: 2, title: "b", body: body("## Owner steps (Tal)\n\n1. `npx wrangler@4 login`\n2. Install:\n   ```ts\n   import { x } from \"y\";\n   ```") },
    { number: 3, title: "c", body: body("## Owner commands\n\nNone.") },
    { number: 4, title: "d", body: body("## Owner commands\n\n```sh\nfrobnicate --everything\n```") },
    { number: 5, title: "e", body: body("## Decisions for the owner\n\n```sh\ngh pr merge 1\n```") },
  ];

  it("reads every heading variant, but not decisions, and keeps shell comments inside a block", () => {
    expect(ownerSections(prs[0].body)[0].text).toContain("gh label create");
    expect(ownerSections(prs[1].body)[0].heading).toBe("Owner steps (Tal)");
    expect(ownerSections(prs[4].body)).toEqual([]);
  });

  it("takes commands from blocks and inline code, skips code to paste, and dedupes across PRs", () => {
    const items = itemsOf(ownerSections(prs[1].body)[0]);
    expect(items.filter((x: Obj) => x.kind === "command").map((x: Obj) => x.text)).toEqual(["npx wrangler@4 login"]);
    expect(items.some((x: Obj) => x.text.includes("import"))).toBe(false);
    expect(normalise("npx wrangler@4.20.0 login   # once")).toBe("npx wrangler login");
    const r = collect(prs);
    expect(r.prs).toBe(4);
    const login = r.items.find((x: Obj) => x.text === "npx wrangler login");
    expect(login.prs).toEqual([1, 2]);
    expect(login.to).toBe("accounts/hosts");
    expect(r.items.find((x: Obj) => x.text.startsWith("gh label")).to).toBe("accounts/github");
    expect(r.items.find((x: Obj) => x.text === "None").to).toBe("none");
    expect(r.items.find((x: Obj) => x.text === "frobnicate --everything").to).toBeNull();
    expect(r.counts.unassigned).toBe(1);
  });

  it("sends test runs to agents and per-merge loops to 'recurring'", () => {
    expect(assign("npx vitest run src/__tests__/a.test.ts", "command")).toBe("agent");
    expect(assign("npm run pr:triage -- --write", "command")).toBe("recurring");
    expect(assign("gh workflow run golden-sets.yml", "command")).toBe("obsolete");
  });

  it("the committed inbox has every open PR's owner command assigned", () => {
    const inbox = JSON.parse(readFileSync(join(ROOT, "scripts/owner/inbox.json"), "utf8"));
    const valid = new Set([...STEPS.map((s: Obj) => s.id), "agent", "recurring", "coordinator", "people", "deferred", "obsolete", "none"]);
    expect(inbox.items.length).toBeGreaterThan(100);
    for (const x of inbox.items) expect(valid.has(x.to)).toBe(true);
  });
});
