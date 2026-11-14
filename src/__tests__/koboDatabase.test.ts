/**
 * Plan W2.15 — the golden KoboReader.sqlite read the way the app reads it
 * (sql.js), giving the same highlights as the rows in kobo-rows.json (which
 * were produced by running KOBO_QUERY on the same file).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { koboRowsToReport, parseKoboDatabase, type KoboRow } from "../highlights/import/kobo";

const DIR = join(__dirname, "fixtures", "highlight-import");

describe("Kobo database through sql.js (W2.15)", () => {
  it("reads the golden KoboReader.sqlite", async () => {
    const node = async () => ((await import("sql.js")).default as unknown as () => Promise<never>)();
    const r = await parseKoboDatabase(new Uint8Array(readFileSync(join(DIR, "KoboReader.sqlite"))), node);
    expect(r).toEqual(koboRowsToReport(JSON.parse(readFileSync(join(DIR, "kobo-rows.json"), "utf8")) as KoboRow[]));
    await expect(parseKoboDatabase(new Uint8Array(readFileSync(join(DIR, "KoboReader.sqlite")).subarray(0, 100)), node)).rejects.toThrow();
  });
});
