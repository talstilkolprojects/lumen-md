/**
 * Plan 14.4 — beta channel and feature flags. Acceptance: a new feature
 * reaches beta before stable. Checked three ways: the version train (betas
 * before the release, betas never "latest"), the flag registry (a stable
 * flag needs an earlier beta), and the flags themselves (beta flags on in
 * beta builds, off in stable).
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — plain .mjs helpers without types
import { compareVersions, isBeta, nextBetaVersion, nextVersion, parseCommits } from "../../scripts/lib/release.mjs";
// @ts-expect-error — plain .mjs helpers without types
import { betaFlags, checkFlags } from "../../scripts/lib/flags.mjs";
import { buildChannel, defaultFor, FLAGS, flagState, isEnabled, readOverrides, resetFlags, setFlag, type FlagDef } from "../flags/flags";
import { setAiPolicy } from "../ai/policy";
import { checkForUpdate, launchUpdateCheck, LAUNCH_CHECK_EVERY_MS, setUpdateChannel, shouldCheckOnLaunch, updateChannel } from "../desktop/updates";

const root = join(process.cwd());
const feat = parseCommits("a\x1ffeat: x\x1f\x1e");
const fix = parseCommits("b\x1ffix: y\x1f\x1e");

/** An in-memory Storage. */
function mem(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

describe("versions: betas come before their release", () => {
  it("semver order, pre-releases first", () => {
    const sorted = ["0.2.0", "0.2.0-beta.10", "0.1.0", "0.2.0-beta.2", "0.2.1", "1.0.0-beta.1", "0.2.0-beta.1"].sort(compareVersions);
    expect(sorted).toEqual(["0.1.0", "0.2.0-beta.1", "0.2.0-beta.2", "0.2.0-beta.10", "0.2.0", "0.2.1", "1.0.0-beta.1"]);
    expect(compareVersions("1.2.3", "v1.2.3")).toBe(0);
  });

  it("the next beta: a stable version starts a train; a beta goes to the next beta", () => {
    expect(nextBetaVersion("0.1.0", feat)).toBe("0.2.0-beta.1");
    expect(nextBetaVersion("0.1.0", fix)).toBe("0.1.1-beta.1");
    expect(nextBetaVersion("0.2.0-beta.1", fix)).toBe("0.2.0-beta.2");
    expect(nextBetaVersion("0.2.0-beta.9", feat)).toBe("0.2.0-beta.10");
    expect(nextBetaVersion("0.2.0-beta.2", [])).toBe(null);
    expect(nextBetaVersion("0.1.0", parseCommits("c\x1fdocs: z\x1f\x1e"))).toBe(null);
  });

  it("…and the stable release after a beta train is that version", () => {
    expect(nextVersion("0.2.0-beta.3", feat)).toBe("0.2.0");
    expect(compareVersions("0.2.0-beta.3", "0.2.0")).toBe(-1);
    expect(isBeta("0.2.0-beta.3")).toBe(true);
    expect(isBeta("0.2.0")).toBe(false);
    expect(isBeta("0.2.0-rc.1")).toBe(false);
  });

  it("the release script: betas are pre-releases, the beta channel never moves backwards, a beta builds as the beta channel", () => {
    const script = readFileSync(join(root, "scripts/release.mjs"), "utf8");
    expect(script).toMatch(/\.\.\.\(\/-\/\.test\(version\) \? \["--prerelease"\] : \[\]\)/);
    expect(script).toMatch(/compareVersions\(version, have\) <= 0/);
    expect(script).toMatch(/VITE_LUMEN_CHANNEL: isBeta\(version\) \? "beta" : "stable"/);
    expect(script).toMatch(/"--exclude", "v\*-\*"/);
    // deploy-beta never deploys to production.
    const deploy = script.slice(script.indexOf('"deploy-beta"()'), script.indexOf("rollback()"));
    expect(deploy).not.toContain("--prod");
  });
});

describe("the flag registry: nothing reaches stable without a beta", () => {
  const registry = JSON.parse(readFileSync(join(root, "src/flags/flags.json"), "utf8"));
  const en = readFileSync(join(root, "src/i18n/index.ts"), "utf8");
  const keys = new Set([...en.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]));
  const he = JSON.parse(readFileSync(join(root, "src/i18n/locales/he.json"), "utf8"));

  it("the shipped registry passes, with strings in English and Hebrew", () => {
    expect(checkFlags(registry, { keys, he })).toEqual([]);
    expect(betaFlags(registry)).toContain("update.checkOnLaunch");
  });

  it("refuses a flag promoted without an earlier beta, a missing since.beta, a bad stage or id, a repeat", () => {
    const bad = (f: object) => checkFlags({ flags: [f] });
    expect(bad({ id: "a.b", stage: "stable", since: { beta: "0.3.0-beta.1", stable: "0.2.0" } }).join()).toMatch(/without an earlier beta/);
    expect(bad({ id: "a.b", stage: "stable", since: { beta: "0.2.0-beta.1" } }).join()).toMatch(/needs since.stable/);
    expect(bad({ id: "a.b", stage: "beta", since: {} }).join()).toMatch(/since.beta/);
    expect(bad({ id: "a.b", stage: "beta", since: { beta: "0.2.0" } }).join()).toMatch(/since.beta/);
    expect(bad({ id: "a.b", stage: "beta", since: { beta: "0.2.0-beta.1", stable: "0.3.0" } }).join()).toMatch(/no since.stable yet/);
    expect(bad({ id: "a.b", stage: "alpha", since: { beta: "0.2.0-beta.1" } }).join()).toMatch(/stage/);
    expect(bad({ id: "Nope", stage: "beta", since: { beta: "0.2.0-beta.1" } }).join()).toMatch(/id/);
    const f = { id: "a.b", stage: "beta", since: { beta: "0.2.0-beta.1" } };
    expect(checkFlags({ flags: [f, f] }).join()).toMatch(/twice/);
    expect(checkFlags({ flags: [{ id: "a.b", stage: "stable", since: { beta: "0.2.0-beta.1", stable: "0.2.0" } }] })).toEqual([]);
    expect(checkFlags({ flags: [f] }, { keys: new Set(), he: {} }).length).toBe(4);
  });
});

describe("flags in the app", () => {
  const beta: FlagDef = { id: "x.beta", stage: "beta", since: { beta: "0.2.0-beta.1" } };
  const stable: FlagDef = { id: "x.stable", stage: "stable", since: { beta: "0.2.0-beta.1", stable: "0.2.0" } };

  it("the channel is a build setting; anything but beta is stable", () => {
    expect(buildChannel({ VITE_LUMEN_CHANNEL: "beta" })).toBe("beta");
    expect(buildChannel({ VITE_LUMEN_CHANNEL: " Beta " })).toBe("beta");
    expect(buildChannel({ VITE_LUMEN_CHANNEL: "nightly" })).toBe("stable");
    expect(buildChannel({})).toBe("stable");
    expect(buildChannel(undefined)).toBe("stable");
  });

  it("a beta feature is on in beta builds and off in stable; a stable one is on everywhere", () => {
    expect(defaultFor(beta, "beta")).toBe(true);
    expect(defaultFor(beta, "stable")).toBe(false);
    expect(defaultFor(stable, "stable")).toBe(true);
    for (const f of FLAGS) if (f.stage === "beta") expect(isEnabled(f.id, { channel: "stable", overrides: {} }), f.id).toBe(false);
    for (const f of FLAGS) if (f.stage === "beta") expect(isEnabled(f.id, { channel: "beta", overrides: {} }), f.id).toBe(true);
  });

  it("the user's choice wins, is local, and can go back to the default; unknown flags are off", () => {
    const s = mem();
    const id = "update.checkOnLaunch";
    setFlag(id, true, s);
    expect(readOverrides(s)).toEqual({ [id]: true });
    expect(flagState(id, { channel: "stable", overrides: readOverrides(s) })).toMatchObject({ enabled: true, source: "override", channelDefault: false });
    setFlag(id, null, s);
    expect(s.getItem("lumen-flags")).toBe(null);
    expect(flagState(id, { channel: "stable", overrides: readOverrides(s) })).toMatchObject({ enabled: false, source: "channel" });
    setFlag("no.such", true, s);
    expect(readOverrides(s)).toEqual({});
    expect(isEnabled("no.such", { channel: "beta", overrides: { "no.such": true } })).toBe(false);
    // A hand-edited store: bad values are ignored.
    s.setItem("lumen-flags", JSON.stringify({ [id]: "yes", other: true }));
    expect(readOverrides(s)).toEqual({});
    s.setItem("lumen-flags", "{not json");
    expect(readOverrides(s)).toEqual({});
    setFlag(id, false, s);
    resetFlags(s);
    expect(readOverrides(s)).toEqual({});
  });
});

describe("desktop update channel", () => {
  setAiPolicy("local-first");
  it("the channel is the user's choice, else the build's; the shell gets a channel name, never a URL", async () => {
    const s = mem();
    expect(updateChannel(s)).toBe("stable");
    setUpdateChannel("beta", s);
    expect(updateChannel(s)).toBe("beta");
    s.setItem("lumen-update-channel", "https://evil.example/latest.json");
    expect(updateChannel(s)).toBe("stable");
    const calls: unknown[][] = [];
    const invoke = (async (...a: unknown[]) => {
      calls.push(a);
      return { state: "up-to-date", current: "0.2.0-beta.1" };
    }) as never;
    await checkForUpdate({ invoke, desktop: true, channel: "beta" });
    expect(calls[0]).toEqual(["update_check", { channel: "beta" }]);
  });

  it("the launch check (beta flag): once a day, only when the flag is on, never outside the desktop app", async () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    expect(shouldCheckOnLaunch(null, now)).toBe(true);
    expect(shouldCheckOnLaunch(new Date(now - 60_000).toISOString(), now)).toBe(false);
    expect(shouldCheckOnLaunch(new Date(now - LAUNCH_CHECK_EVERY_MS).toISOString(), now)).toBe(true);
    expect(shouldCheckOnLaunch(new Date(now + 3_600_000).toISOString(), now)).toBe(true); // a clock set back
    expect(shouldCheckOnLaunch("garbage", now)).toBe(true);

    let n = 0;
    const invoke = (async () => {
      n++;
      return { state: "available", current: "0.2.0-beta.1", version: "0.2.0-beta.2", notes: null };
    }) as never;
    const s = mem();
    expect(await launchUpdateCheck({ invoke, desktop: true, enabled: false, storage: s, now })).toBe(null);
    expect(await launchUpdateCheck({ invoke, desktop: false, enabled: true, storage: s, now })).toBe(null);
    expect(n).toBe(0);
    expect(await launchUpdateCheck({ invoke, desktop: true, enabled: true, storage: s, now })).toMatchObject({ state: "available" });
    expect(await launchUpdateCheck({ invoke, desktop: true, enabled: true, storage: s, now: now + 1000 })).toBe(null);
    expect(n).toBe(1);
    expect(await launchUpdateCheck({ invoke, desktop: true, enabled: true, storage: s, now: now + LAUNCH_CHECK_EVERY_MS })).toMatchObject({ state: "available" });
    expect(n).toBe(2);
    // local-only: no automatic check at all.
    setAiPolicy("local-only");
    expect(await launchUpdateCheck({ invoke, desktop: true, enabled: true, storage: mem(), now })).toBe(null);
    expect(n).toBe(2);
    setAiPolicy("local-first");
  });
});

describe("docs", () => {
  it("the beta page exists in English and Hebrew, in the sidebar, and lists every beta flag", () => {
    const sidebar = readFileSync(join(root, "docs/astro.config.mjs"), "utf8");
    expect(sidebar).toContain('slug: "getting-started/beta"');
    const en = readFileSync(join(root, "docs/src/content/docs/getting-started/beta.md"), "utf8");
    const heDoc = readFileSync(join(root, "docs/src/content/docs/he/getting-started/beta.md"), "utf8");
    const enStrings = readFileSync(join(root, "src/i18n/index.ts"), "utf8");
    const he = JSON.parse(readFileSync(join(root, "src/i18n/locales/he.json"), "utf8")) as Record<string, string>;
    for (const f of FLAGS.filter((x) => x.stage === "beta")) {
      const name = new RegExp(`"flag\\.${f.id.replace(/\./g, "\\.")}\\.name": "([^"]+)"`).exec(enStrings)![1];
      expect(en).toContain(`| ${name} |`);
      expect(heDoc).toContain(`| ${he[`flag.${f.id}.name`]} |`);
    }
  });
});
