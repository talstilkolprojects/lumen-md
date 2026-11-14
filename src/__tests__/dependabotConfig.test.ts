// @vitest-environment node
/**
 * Decision 2.73 (#499, dependabot #153): the MCP server runs on Node 22,
 * so dependabot must not propose @types/node majors for /mcp-server.
 * Patches and minors of the 22 line still come through.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

type Ignore = { "dependency-name": string; "update-types"?: string[]; versions?: string[] };
type Update = { "package-ecosystem": string; directory: string; ignore?: Ignore[] };

const config = parse(readFileSync(".github/dependabot.yml", "utf8")) as { version: number; updates: Update[] };
const mcp = config.updates.filter((u) => u["package-ecosystem"] === "npm" && u.directory === "/mcp-server");

describe("dependabot config (decision 2.73)", () => {
  it("parses as dependabot v2 with one npm entry for /mcp-server", () => {
    expect(config.version).toBe(2);
    expect(mcp).toHaveLength(1);
  });

  it("ignores @types/node semver-major updates in /mcp-server only for majors", () => {
    const rules = (mcp[0].ignore ?? []).filter((r) => r["dependency-name"] === "@types/node");
    expect(rules).toHaveLength(1);
    expect(rules[0]["update-types"]).toEqual(["version-update:semver-major"]);
    expect(rules[0].versions).toBeUndefined();
  });

  it("keeps the ignored major in line with the server's runtime (Node 22 types)", () => {
    const pkg = JSON.parse(readFileSync("mcp-server/package.json", "utf8"));
    expect(pkg.engines.node).toBe(">=22");
    expect(pkg.devDependencies?.["@types/node"] ?? pkg.dependencies?.["@types/node"]).toMatch(/^\^22\./);
  });

  it("does not ignore @types/node anywhere else", () => {
    const others = config.updates.filter((u) => u !== mcp[0]);
    for (const u of others) {
      expect((u.ignore ?? []).some((r) => r["dependency-name"] === "@types/node")).toBe(false);
    }
  });
});
