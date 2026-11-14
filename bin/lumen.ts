#!/usr/bin/env node
/**
 * `lumen` CLI — headless document conversion.
 *
 *   lumen convert <input> [output]   convert a file (format from extensions)
 *   lumen formats                    list supported import/export formats
 *   lumen publish <dir|file> --out <dir> [--title <name>]
 *                                    render .md files to a static website
 *   lumen search|open|new|append|daily|mcp …
 *                                    the vault on disk (plan W2.3) — see
 *                                    mcp-server/src/cli.ts
 *
 * Run with:  npx tsx bin/lumen.ts convert notes.md notes.tex
 *            npx tsx bin/lumen.ts publish docs --out site
 */
import { readFileSync, writeFileSync } from "node:fs";
import { convert, convertBinary, isBinaryTarget, listFormats } from "../src/cli/convert";
import { publishSite } from "../src/cli/publish";
import { runVaultCli, USAGE as VAULT_USAGE, VAULT_COMMANDS } from "../mcp-server/src/cli";

const USAGE = [
  "usage: lumen convert <input> [output]",
  "       lumen formats",
  "       lumen publish <dir|file> --out <dir> [--title <name>]",
  VAULT_USAGE.replace(/^usage: /, "       "),
].join("\n");

/** Parse `--flag value` / `--flag=value` pairs; returns flags + positionals. */
function parseFlags(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
    if (!m) positional.push(a);
    else if (m[2] !== undefined) flags[m[1]] = m[2];
    else flags[m[1]] = args[++i] ?? "";
  }
  return { flags, positional };
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;

  if ((VAULT_COMMANDS as readonly string[]).includes(cmd)) {
    return runVaultCli(argv, { out: (l) => console.log(l), err: (l) => console.error(l), env: process.env, cwd: process.cwd() });
  }

  if (cmd === "formats") {
    const f = listFormats();
    console.log("export (md → X):", f.export.join(", "));
    console.log("import (X → md):", f.import.join(", "));
    return 0;
  }

  if (cmd === "publish") {
    const { flags, positional } = parseFlags(rest);
    const out = flags.out;
    if (positional.length !== 1 || !out) {
      console.error(USAGE);
      return 1;
    }
    const res = await publishSite(positional[0], out, { siteTitle: flags.title || undefined });
    for (const s of res.skipped) {
      console.warn(`! skipped ${s.source}: ${s.output} ${s.reason}`);
    }
    console.log(`✓ published ${res.pages.length} page(s) + ${res.assets.length} asset(s) → ${res.index}`);
    return 0;
  }

  if (cmd !== "convert" || rest.length < 1) {
    console.error(USAGE);
    return 1;
  }

  const inFile = rest[0];
  const inText = readFileSync(inFile, "utf8");
  const toExt = rest[1] ? rest[1].split(".").pop() : undefined;

  if (toExt && isBinaryTarget(toExt)) {
    const { outName, bytes } = await convertBinary(inFile, inText, toExt);
    const outFile = rest[1] || outName;
    writeFileSync(outFile, bytes);
    console.log(`✓ ${inFile} → ${outFile} (${bytes.length} bytes)`);
    return 0;
  }

  const { outName, outText } = convert(inFile, inText, toExt);
  const outFile = rest[1] || outName;
  writeFileSync(outFile, outText);
  console.log(`✓ ${inFile} → ${outFile} (${outText.length} bytes)`);
  return 0;
}

main(process.argv.slice(2))
  // -1: `lumen mcp serve` keeps running.
  .then((code) => {
    if (code >= 0) process.exit(code);
  })
  .catch((err) => {
    console.error("error:", (err as Error).message);
    process.exit(1);
  });
