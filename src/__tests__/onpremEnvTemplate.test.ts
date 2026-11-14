/** The on-prem env template declares every variable docker-compose.yml reads. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");

describe(".env.onprem.example", () => {
  it("declares every LUMEN_* variable of docker-compose.yml (e.g. the collab token)", () => {
    const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");
    const template = readFileSync(join(root, ".env.onprem.example"), "utf8");
    const used = [...new Set([...compose.matchAll(/\$\{(LUMEN_[A-Z0-9_]+)/g)].map((m) => m[1]))];
    expect(used).toContain("LUMEN_COLLAB_TOKEN");
    const missing = used.filter((v) => !new RegExp(`^${v}=`, "m").test(template));
    expect(missing).toEqual([]);
  });
});
