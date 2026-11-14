/**
 * Named versions in a shared note (W3.11): "Before submission", "Draft 2".
 *
 * A version is a full copy of the text with a name, who saved it and when.
 * It lives in the shared document itself (a Y.Array next to the text), so
 * every participant sees the same list, and the server's roles apply: only
 * editors can add one, everyone can compare. Two versions, or a version and
 * the current text, are compared word by word (wordDiff.ts).
 */
import type * as Y from "yjs";
import { randomId } from "../lib/cryptoRandom";
import { wordDiff, diffStats, type DiffOp } from "./wordDiff";

export interface NamedVersion {
  id: string;
  name: string;
  text: string;
  author: string | null;
  at: number;
}

export const VERSIONS_KEY = "lumen.namedVersions";
export const MAX_NAME = 80;

/** The smallest part of Y.Array that named versions use (a fake fits in tests). */
export interface VersionList {
  toArray(): unknown[];
  push(items: unknown[]): void;
  observe(fn: () => void): void;
  unobserve(fn: () => void): void;
}

export function versionList(doc: Y.Doc): VersionList {
  return doc.getArray(VERSIONS_KEY) as unknown as VersionList;
}

function isVersion(v: unknown): v is NamedVersion {
  const x = v as NamedVersion;
  return !!x && typeof x.id === "string" && typeof x.name === "string" && typeof x.text === "string" && typeof x.at === "number";
}

/** Versions, newest first. Anything malformed (a buggy or hostile peer) is skipped. */
export function listVersions(list: VersionList): NamedVersion[] {
  return list.toArray().filter(isVersion).sort((a, b) => b.at - a.at);
}

export function cleanVersionName(name: string): string {
  return name.replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

/** Save the text as a named version. Returns it, or null for an empty name. */
export function addVersion(list: VersionList, name: string, text: string, author: string | null, now = Date.now()): NamedVersion | null {
  const clean = cleanVersionName(name);
  if (!clean) return null;
  const v: NamedVersion = { id: randomId(), name: clean, text, author: author ? author.slice(0, 64) : null, at: now };
  list.push([v]);
  return v;
}

export interface Comparison {
  ops: DiffOp[];
  added: number;
  removed: number;
}

export function compareVersions(older: string, newer: string): Comparison {
  const ops = wordDiff(older, newer);
  return { ops, ...diffStats(ops) };
}
