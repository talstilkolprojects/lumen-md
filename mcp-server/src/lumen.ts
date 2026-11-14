#!/usr/bin/env node
/** The `lumen` command (bin of @lumen-md/mcp-server); see cli.ts. */
import { createInterface } from "node:readline/promises";
import { runVaultCli } from "./cli.js";

// Approving needs a terminal (both ends a TTY), each diff on screen and a typed yes (review 21, B1).
// A terminal is not proof of a person: an agent can open a pty (review 24). See CliIO.tty.
const tty = !!process.stdin.isTTY && !!process.stdout.isTTY;
const ask = async (q: string) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(q);
  } finally {
    rl.close();
  }
};

runVaultCli(process.argv.slice(2), { out: (l) => process.stdout.write(l + "\n"), err: (l) => process.stderr.write(l + "\n"), env: process.env, cwd: process.cwd(), tty, ask })
  .then((code) => {
    // -1: `lumen mcp serve` keeps running.
    if (code >= 0) process.exit(code);
  })
  .catch((e) => {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    process.exit(1);
  });
