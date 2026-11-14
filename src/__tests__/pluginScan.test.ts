/**
 * The scan of every plugin version (plan W1.20, src/plugins/runtime/scan.ts)
 * and the registry's scan results (public/plugins/examples/scan.json).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scanPluginVersion, visibleVersions, type ScanResult } from "../plugins/runtime/scan";
import { describeCapability, isSensitive } from "../plugins/runtime/permissions";

const manifest = (caps: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ schema: 1, id: "org.example.test", name: "Test", version: "1.0.0", description: "d", author: "a", license: "MIT", main: "main.js", capabilities: caps.map((id) => ({ id, reason: `needs ${id}` })), ...extra });
const rules = (r: ScanResult) => r.findings.map((f) => `${f.severity}:${f.rule}`).sort();

describe("plugin scan", () => {
  it("a plugin that reaches the network without declaring it is blocked", async () => {
    const r = await scanPluginVersion({ manifest: manifest(["commands"]), main: `await lumen.commands.register({ id: "x", label: "x" }, async () => { await lumen.network.fetch("https://collector.example.com/steal"); });` });
    expect(r.passed).toBe(false);
    expect(r.grade).toBe("F");
    expect(r.findings).toContainEqual(expect.objectContaining({ rule: "undeclared-network", severity: "error", detail: "https://collector.example.com" }));
  });

  it("a fetch to an origin other than the declared one is blocked too; the declared one passes", async () => {
    const other = await scanPluginVersion({ manifest: manifest(["network:https://example.com"]), main: `await lumen.network.fetch("https://example.org/x");` });
    expect(rules(other)).toContain("error:undeclared-network");
    const same = await scanPluginVersion({ manifest: manifest(["network:https://example.com"]), main: `await lumen.network.fetch("https://example.com/x");` });
    expect(same.passed).toBe(true);
    expect(same.used).toEqual(["network:https://example.com"]);
  });

  it("a URL in a string constant is checked like a literal", async () => {
    const ok = await scanPluginVersion({ manifest: manifest(["network:https://example.com"]), main: `const SRC = "https://example.com/q.json";\nawait lumen.network.fetch(SRC);` });
    expect(ok.findings).toEqual([expect.objectContaining({ rule: "unsigned" })]);
    const bad = await scanPluginVersion({ manifest: manifest(["network:https://example.com"]), main: `const SRC = "https://example.org/q.json";\nawait lumen.network.fetch(SRC);` });
    expect(rules(bad)).toContain("error:undeclared-network");
  });

  it("an API call whose capability is not declared fails; one declared but unused is a warning", async () => {
    const r = await scanPluginVersion({ manifest: manifest(["document:read", "clipboard:write"]), main: `const s = await lumen.document.getText(); await lumen.document.setText(s.toUpperCase());` });
    expect(r.passed).toBe(false);
    expect(r.findings).toContainEqual(expect.objectContaining({ rule: "undeclared", detail: "document:write" }));
    expect(r.findings).toContainEqual(expect.objectContaining({ rule: "unused", severity: "warning", detail: "clipboard:write" }));
  });

  it.each([
    ["eval", `eval("1+1")`],
    ["eval", `const f = new Function("return 1")`],
    ["eval", `setTimeout("doIt()", 10)`],
    ["dynamic-import", `const m = await import("https://example.com/x.js")`],
    ["dynamic-import", `import x from "./x.js"`],
    ["obfuscated-access", `const k = "ev" + "al"; globalThis[k]("1")`],
    ["obfuscated-access", `const a = ["net", "work"].join(""); lumen[a].fetch("https://example.com")`],
    ["syntax", `function (`],
  ])("%s: %s is an error", async (rule, code) => {
    const r = await scanPluginVersion({ manifest: manifest([]), main: code });
    expect(r.passed).toBe(false);
    expect(r.findings.map((f) => f.rule)).toContain(rule);
  });

  it("strings and comments that mention eval are not code", async () => {
    const r = await scanPluginVersion({ manifest: manifest(["notifications"]), main: `// never eval("x")\nawait lumen.notifications.show("no eval( here", "info");` });
    expect(r.findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  it("indirect use of the API is a warning (calls cannot all be checked); oversize code fails", async () => {
    const r = await scanPluginVersion({ manifest: manifest(["document:read"]), main: `const d = lumen.document; await d.getText();` });
    expect(r.findings.map((f) => f.rule)).toContain("indirect-api");
    const big = await scanPluginVersion({ manifest: manifest([]), main: `/*${"x".repeat(600 * 1024)}*/` });
    expect(rules(big)).toContain("error:size");
  });

  it("a signature that does not verify fails; an unknown signer is a warning", async () => {
    const base = { manifest: manifest([]), main: "1;", signature: { signature: "AAAA", signedBy: "ab" } };
    expect((await scanPluginVersion({ ...base, verify: async () => false })).findings.map((f) => f.rule)).toContain("signature");
    const u = await scanPluginVersion({ ...base, verify: async () => "untrusted-signer" as const });
    expect(u.passed).toBe(true);
    expect(u.findings.map((f) => f.rule)).toContain("untrusted-signer");
    expect((await scanPluginVersion({ ...base, verify: async () => true })).findings).toEqual([]);
  });

  it("only versions that passed are shown", () => {
    const v = visibleVersions([{ v: "1", scan: { passed: true } }, { v: "2", scan: { passed: false } }, { v: "3", scan: null }]);
    expect(v.map((x) => x.v)).toEqual(["1"]);
  });

  it("every capability has plain-language text; network names its origin", () => {
    for (const cap of ["document:read", "document:write", "vault:read", "vault:write", "commands", "panel", "renderer", "settings", "storage", "clipboard:write", "notifications"]) {
      expect(describeCapability(cap), cap).not.toMatch(/^pluginTrust\./);
    }
    expect(describeCapability("network:https://example.com")).toContain("https://example.com");
    expect(isSensitive("network:https://example.com") && isSensitive("vault:write") && !isSensitive("panel")).toBe(true);
  });
});

describe("the registry: 100% of versions scanned, with a card", () => {
  const DIR = resolve(__dirname, "..", "..", "public", "plugins", "examples");
  const index = JSON.parse(readFileSync(join(DIR, "index.json"), "utf8")) as { plugins: Array<{ id: string; versions: Array<{ version: string; path: string }> }> };
  const scans = JSON.parse(readFileSync(join(DIR, "scan.json"), "utf8")) as { results: Array<ScanResult & { path: string }> };

  it("each version in index.json has a scan result in scan.json, and it is current", async () => {
    const versions = index.plugins.flatMap((p) => p.versions.map((v) => ({ id: p.id, ...v })));
    expect(versions.length).toBeGreaterThanOrEqual(3);
    for (const v of versions) {
      const stored = scans.results.find((r) => r.id === v.id && r.version === v.version);
      expect(stored, `${v.id}@${v.version}`).toBeDefined();
      const m = readFileSync(join(DIR, v.path, "lumen-plugin.json"), "utf8");
      const fresh = await scanPluginVersion({ manifest: m, main: readFileSync(join(DIR, v.path, (JSON.parse(m) as { main: string }).main), "utf8") });
      expect({ ...fresh, path: v.path }, `${v.id}@${v.version}: run node scripts/scan-plugins.mjs`).toEqual(stored);
      // The card's fields.
      expect(typeof stored!.score === "number" && ["A", "B", "C", "F"].includes(stored!.grade)).toBe(true);
    }
    expect(scans.results.length).toBe(versions.length);
  });

  it("every example passes, each using exactly what it declares", () => {
    for (const r of scans.results) {
      expect(r.passed, r.id).toBe(true);
      expect(r.findings.filter((f) => f.rule === "unused" || f.rule === "undeclared"), r.id).toEqual([]);
    }
  });
});
