/**
 * Review 11, RR11-451-2 (X6): a frame inside a closed declarative shadow root
 * (`setHTMLUnsafe` / `parseHTMLUnsafe` with `<template shadowrootmode="closed">`)
 * is out of airplane mode's reach: no `attachShadow` runs, so the frame guard
 * never sees it. The decision (docs/security/accepted-risks.md): the app never
 * builds one, and the certificate says so. This test keeps both true: no app
 * file calls these APIs or writes a declarative shadow root, and the
 * certificate names them as out of reach.
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "node_modules" || f === "__tests__" ? [] : files(p);
    return /\.(ts|tsx|js|mjs)$/.test(f) && !f.endsWith(".d.ts") ? [p] : [];
  });
}

describe("closed declarative shadow roots (review 11, RR11-451-2 / X6)", () => {
  it("no app file builds a declarative shadow root", () => {
    const pattern = /\b(setHTMLUnsafe|parseHTMLUnsafe)\b|shadowrootmode|shadowroot(?:clonable|delegatesfocus|serializable)\b/i;
    const hits = files(SRC)
      .filter((f) => !f.endsWith("airplaneCertificate.ts"))
      .filter((f) => pattern.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(hits).toEqual([]);
  });

  it("the certificate names them as out of reach", () => {
    const cert = readFileSync(join(SRC, "privacy", "airplaneCertificate.ts"), "utf8");
    expect(cert).toMatch(/closed declarative shadow root \(setHTMLUnsafe, parseHTMLUnsafe\), is out of reach/);
  });
});
