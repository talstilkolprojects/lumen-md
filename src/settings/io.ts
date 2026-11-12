/**
 * Settings export / import (plan 11.1).
 *
 * The file holds only entries of kind `setting` from the schema: never a
 * secret (keys, tokens), never content or caches, never the plugin trust
 * list or the org policy. An import checks every value against its entry
 * and skips what doesn't fit, so a hand-edited or foreign file can't put
 * an unknown key or a wrong type into storage.
 *
 * One more rule: an import never loosens privacy. A file that says `cloud`
 * doesn't switch a device that keeps AI on this device to the cloud, and the
 * same holds for the other safeguards (`loosens` below): PII redaction and
 * its preview, the encrypted vault's auto-lock, and the endpoints that
 * receive note text, which an import keeps only when they stay on this
 * machine (loopback) or equal what the device already uses. The user changes
 * those on purpose, in their tab. Refused keys are listed in `refused`.
 */

import { SETTINGS, entryForAppField, entryForLocalKey, type SettingEntry } from "./schema";

export const SETTINGS_FORMAT = "lumen-settings";
const MAX_LOCAL_VALUE = 64 * 1024;
const POLICY_KEY = "lumen.ai.policy";
const POLICY_RANK: Record<string, number> = { "local-only": 0, "local-first": 1, cloud: 2 };

export interface SettingsFile {
  format: typeof SETTINGS_FORMAT;
  version: 1;
  app: Record<string, unknown>;
  local: Record<string, string>;
}

/** What export / import read and write: the store and localStorage. */
export interface SettingsTarget {
  getApp: () => Record<string, unknown>;
  /** Applies validated store fields (the caller routes side effects, e.g. the theme). */
  applyApp: (patch: Record<string, unknown>) => void;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
}

export interface ImportResult {
  applied: number;
  /** Every key not imported (unknown, wrong type, refused, or storage denied). */
  skipped: string[];
  /** The keys of `skipped` refused because the value would loosen a privacy safeguard. */
  refused: string[];
}

/** Endpoints that receive note text: imported only when loopback or unchanged. */
export const CONTENT_ENDPOINTS: readonly string[] = ["lumen.research.endpoint", "lumen.ollama.baseUrl", "lumen.grammar.endpoint", "lumen.collab.signaling"];

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i;

/** Every URL in the value (the signaling list is comma-separated) points at this machine. */
export function isLoopbackValue(value: string): boolean {
  const parts = value.split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return false;
  return parts.every((p) => {
    try {
      return LOOPBACK.test(new URL(p).hostname);
    } catch {
      return false;
    }
  });
}

/** Minutes before the encrypted vault locks; 0 = never (the loosest). */
const lockLooseness = (v: string | null) => {
  const n = v === null || v === "" ? 15 : Number(v);
  return n === 0 ? Infinity : n;
};

/**
 * Would writing `value` to `key` loosen a privacy safeguard on this device?
 * (`current` is what the device holds now, null when unset.)
 */
export function loosens(key: string, value: string, current: string | null): boolean {
  switch (key) {
    case POLICY_KEY:
      return (POLICY_RANK[value] ?? 3) > (POLICY_RANK[current ?? "local-only"] ?? 0);
    case "lumen.ai.redact": // on unless "off"
      return value === "off" && current !== "off";
    case "lumen.ai.redact.preview": // on only when "1"
      return value !== "1" && current === "1";
    case "lumen.images.keepMetadata": // W5.11: photos lose their metadata unless "1"
      return value === "1" && current !== "1";
    case "lumen.vaultLock.minutes":
      return lockLooseness(value) > lockLooseness(current);
    default:
      if (CONTENT_ENDPOINTS.includes(key)) return value !== (current ?? "") && !isLoopbackValue(value);
      return false;
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function storageKeys(storage: SettingsTarget["storage"]): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k !== null) keys.push(k);
  }
  return keys;
}

/** A store field value that fits its entry. */
export function validAppValue(entry: SettingEntry, value: unknown): boolean {
  switch (entry.type) {
    case "boolean":
      return entry.values ? typeof value === "string" && entry.values.includes(value) : typeof value === "boolean";
    case "choice":
      return typeof value === "string" && (entry.options ?? []).some((o) => o.value === value);
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (entry.min === undefined || value >= entry.min) &&
        (entry.max === undefined || value <= entry.max)
      );
    case "text":
      return typeof value === "string" || value === null;
    case "json":
      return isPlainObject(value);
    default:
      return false;
  }
}

/** A localStorage value (always text) that fits its entry. */
export function validLocalValue(entry: SettingEntry, value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_LOCAL_VALUE) return false;
  switch (entry.type) {
    case "boolean":
      return (entry.values ?? ["", "1"]).includes(value);
    case "choice":
      return (entry.options ?? []).some((o) => o.value === value);
    case "number": {
      if (!/^-?\d+(\.\d+)?$/.test(value)) return false;
      const n = Number(value);
      return (entry.min === undefined || n >= entry.min) && (entry.max === undefined || n <= entry.max);
    }
    case "text":
      return true;
    case "json":
      try {
        JSON.parse(value);
        return true;
      } catch {
        return false;
      }
    default:
      return false;
  }
}

export function exportSettings(target: SettingsTarget): SettingsFile {
  const state = target.getApp();
  const app: Record<string, unknown> = {};
  for (const e of SETTINGS) {
    if (e.store === "app" && e.kind === "setting" && e.id in state) app[e.id] = state[e.id];
  }
  const local: Record<string, string> = {};
  for (const key of storageKeys(target.storage).sort()) {
    if (entryForLocalKey(key)?.kind !== "setting") continue;
    const value = target.storage.getItem(key);
    if (value !== null) local[key] = value;
  }
  return { format: SETTINGS_FORMAT, version: 1, app, local };
}

/** The parsed file, or null when the text isn't a settings export. */
export function parseSettingsFile(text: string): SettingsFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(raw) || raw.format !== SETTINGS_FORMAT || raw.version !== 1) return null;
  const app = isPlainObject(raw.app) ? raw.app : {};
  const local: Record<string, string> = {};
  if (isPlainObject(raw.local)) {
    for (const [k, v] of Object.entries(raw.local)) if (typeof v === "string") local[k] = v;
  }
  return { format: SETTINGS_FORMAT, version: 1, app, local };
}

export function importSettings(file: SettingsFile, target: SettingsTarget): ImportResult {
  const skipped: string[] = [];
  const refused: string[] = [];
  const patch: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(file.app)) {
    const entry = entryForAppField(field);
    if (entry?.kind === "setting" && validAppValue(entry, value)) patch[field] = value;
    else skipped.push(field);
  }
  let applied = Object.keys(patch).length;
  if (applied) target.applyApp(patch);

  for (const [key, value] of Object.entries(file.local)) {
    const entry = entryForLocalKey(key);
    if (entry?.kind !== "setting" || !validLocalValue(entry, value)) {
      skipped.push(key);
      continue;
    }
    if (loosens(key, value, target.storage.getItem(key))) {
      skipped.push(key);
      refused.push(key);
      continue;
    }
    try {
      if (value === "") target.storage.removeItem(key);
      else target.storage.setItem(key, value);
      applied++;
    } catch {
      skipped.push(key); // storage full or denied
    }
  }
  return { applied, skipped, refused };
}
