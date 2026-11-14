/**
 * Plan W11.S1: the encrypted sync is off by default in every channel and
 * says, on the screen that turns it on, that its cryptography has had no
 * external security audit — in Hebrew and in English. No user-facing text
 * may call the cryptography audited until a report is published.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildChannel, FLAGS, flagState, isEnabled, readOverrides, type Channel } from "../flags/flags";
import { applyLocale, loadLocale } from "../i18n";
import { E2eeGate, UnauditedNotice, whenE2eeOn } from "../sync/e2ee/ui/unaudited";
// @ts-expect-error — plain .mjs module without types
import { checkFlags, auditPublished } from "../../scripts/lib/flags.mjs";
// @ts-expect-error — plain .mjs module without types
import { auditClaims, scanRepo } from "../../scripts/security/audit-claims.mjs";

const ROOT = resolve(__dirname, "..", "..");
const registry = JSON.parse(readFileSync(join(ROOT, "src/flags/flags.json"), "utf8")) as { flags: Array<{ id: string; stage: string }> };
const cryptoAudit = JSON.parse(readFileSync(join(ROOT, "security/crypto-audit.json"), "utf8")) as { external: unknown };
const PUBLISHED = { external: { auditor: "Example Security GmbH", date: "2027-03-01", report: "https://example.org/report.pdf" } };

beforeEach(() => {
  localStorage.clear();
  applyLocale("en");
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  applyLocale("en");
});

describe("sync.e2ee is off by default in every channel", () => {
  it("is registered as experimental and needs a crypto audit", () => {
    const f = FLAGS.find((x) => x.id === "sync.e2ee");
    expect(f?.stage).toBe("experimental");
    expect(f?.requiresAudit).toBe("crypto");
  });

  // Web, desktop (Tauri) and mobile (Capacitor) all ship the same web build; the build's only channel input is VITE_LUMEN_CHANNEL.
  it.each(["", "stable", "beta", "BETA", " beta ", "nightly"])("VITE_LUMEN_CHANNEL=%j → off", (v) => {
    const channel: Channel = buildChannel({ VITE_LUMEN_CHANNEL: v });
    expect(flagState("sync.e2ee", { channel, overrides: {} })).toMatchObject({ enabled: false, channelDefault: false, source: "channel" });
    expect(isEnabled("sync.e2ee", { channel, overrides: {} })).toBe(false);
  });

  it("only the user's own choice turns it on, and the beta flags still follow the channel", () => {
    expect(isEnabled("sync.e2ee", { channel: "beta", overrides: { "sync.e2ee": true } })).toBe(true);
    expect(isEnabled("update.checkOnLaunch", { channel: "beta", overrides: {} })).toBe(true);
    expect(isEnabled("update.checkOnLaunch", { channel: "stable", overrides: {} })).toBe(false);
    expect(readOverrides(localStorage)).toEqual({});
  });

  it("flags:check refuses to move it out of experimental while no external audit is published", () => {
    expect(cryptoAudit.external).toBeNull();
    expect(auditPublished(cryptoAudit)).toBe(false);
    expect(checkFlags(registry, { audit: cryptoAudit })).toEqual([]);
    for (const stage of ["beta", "stable"]) {
      const moved = { flags: registry.flags.map((f) => (f.id === "sync.e2ee" ? { ...f, stage, since: { beta: "0.2.0-beta.1", ...(stage === "stable" ? { stable: "0.3.0" } : {}) } } : f)) };
      expect(checkFlags(moved, { audit: cryptoAudit }).join("\n")).toMatch(/sync\.e2ee: stays "experimental" until/);
      expect(checkFlags(moved, { audit: PUBLISHED })).toEqual([]);
    }
    // A report needs an https URL, an auditor and a date.
    expect(auditPublished({ external: { auditor: "x", date: "2027-03-01", report: "http://x" } })).toBe(false);
    expect(auditPublished({ external: { auditor: "", date: "2027-03-01", report: "https://x" } })).toBe(false);
  });
});

describe("the activation screen says it is unaudited, in Hebrew and English", () => {
  it("English", () => {
    render(<E2eeGate onEnable={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByTestId("e2ee-unaudited").textContent).toContain("Experimental — not externally security-audited");
  });

  it("Hebrew", async () => {
    await loadLocale("he");
    applyLocale("he");
    render(<E2eeGate onEnable={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByTestId("e2ee-unaudited").textContent).toContain("ניסיוני — לא עבר ביקורת אבטחה חיצונית");
    expect(screen.getByTestId("e2ee-gate").getAttribute("dir")).toBe("rtl");
  });

  it("the notice is on the guided setup and the sync panel too", () => {
    for (const file of ["src/sync/e2ee/ui/SetupWizard.tsx", "src/sync/e2ee/ui/SyncPanel.tsx"]) {
      expect(readFileSync(join(ROOT, file), "utf8"), file).toMatch(/<UnauditedNotice \/>/);
    }
    render(<UnauditedNotice />);
    expect(screen.getByTestId("e2ee-unaudited").textContent).toMatch(/outside security firm/);
  });

  it("whenE2eeOn: with the flag off it shows the gate and runs nothing until the user turns it on", async () => {
    let ran = 0;
    const done = whenE2eeOn(() => void ran++);
    await waitFor(() => screen.getByTestId("e2ee-gate"));
    expect(ran).toBe(0);
    fireEvent.click(screen.getByTestId("e2ee-gate-enable"));
    await done;
    expect(ran).toBe(1);
    expect(readOverrides(localStorage)).toEqual({ "sync.e2ee": true });
    expect(screen.queryByTestId("e2ee-gate")).toBeNull();
    // Now on: runs at once, no gate.
    await whenE2eeOn(() => void ran++);
    expect(ran).toBe(2);
    expect(screen.queryByTestId("e2ee-gate")).toBeNull();
  });

  it("whenE2eeOn: 'Not now' runs nothing and leaves the flag off", async () => {
    let ran = 0;
    const done = whenE2eeOn(() => void ran++);
    await waitFor(() => screen.getByTestId("e2ee-gate"));
    fireEvent.click(screen.getByTestId("e2ee-gate-cancel"));
    await done;
    expect(ran).toBe(0);
    expect(isEnabled("sync.e2ee", { overrides: readOverrides(localStorage) })).toBe(false);
  });

  it("the sync and classroom launchers go through the gate", () => {
    expect(readFileSync(join(ROOT, "src/sync/e2ee/ui/launch.ts"), "utf8").match(/whenE2eeOn\(/g)).toHaveLength(2);
    expect(readFileSync(join(ROOT, "src/sync/e2ee/classroom/launch.ts"), "utf8").match(/whenE2eeOn\(/g)).toHaveLength(2);
  });
});

describe("no user-facing text calls the cryptography audited without a published report", () => {
  it("catches claims, in English and Hebrew", () => {
    for (const s of [
      "Lumen's end-to-end encryption is audited.",
      "Our E2EE was security audited by Cure53",
      "The encryption passed a third-party audit.",
      "ההצפנה של Lumen מבוקרת.",
      "הקריפטו עבר ביקורת אבטחה חיצונית.",
    ]) {
      expect(auditClaims(s), s).toHaveLength(1);
    }
  });

  it("lets honest statements through", () => {
    for (const s of [
      "The encryption has not been externally audited.",
      "Experimental — not externally security-audited",
      "Unaudited cryptography: keep a backup.",
      "ניסיוני — לא עבר ביקורת אבטחה חיצונית",
      "ההצפנה עוד לא עברה ביקורת אבטחה חיצונית, עד שתהיה ביקורת.",
      "Every release is audited under the local-only policy with an outside network analyzer.",
    ]) {
      expect(auditClaims(s), s).toEqual([]);
    }
  });

  it("the repository has none", () => {
    expect(scanRepo(ROOT)).toEqual([]);
  });

  it("a claim planted in a docs page is found, and allowed once a report is published", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "audit-claims-"));
    try {
      mkdirSync(join(dir, "security"));
      mkdirSync(join(dir, "docs/src/content/docs/sync"), { recursive: true });
      mkdirSync(join(dir, "src/i18n/locales/he"), { recursive: true });
      writeFileSync(join(dir, "security/crypto-audit.json"), JSON.stringify({ external: null }));
      writeFileSync(join(dir, "docs/src/content/docs/sync/e2ee.md"), "# Sync\n\nOur encryption is independently audited.\n");
      writeFileSync(join(dir, "src/i18n/locales/he/common.json"), JSON.stringify({ "x.y": "הצפנה מבוקרת מקצה לקצה" }));
      expect(scanRepo(dir).map((f: { file: string }) => f.file).sort()).toEqual(["docs/src/content/docs/sync/e2ee.md", "src/i18n/locales/he/common.json"]);
      expect(scanRepo(dir, { audit: PUBLISHED })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
