#!/usr/bin/env node
/** The `lumen` command (bin of @lumen-md/mcp-server); see cli.ts. */
import { runVaultCli } from "./cli.js";

runVaultCli(process.argv.slice(2), { out: (l) => process.stdout.write(l + "\n"), err: (l) => process.stderr.write(l + "\n"), env: process.env, cwd: process.cwd() })
  .then((code) => {
    // -1: `lumen mcp serve` keeps running.
    if (code >= 0) process.exit(code);
  })
  .catch((e) => {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    process.exit(1);
  });
