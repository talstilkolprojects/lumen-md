/**
 * Local feature flags and the release channel (plan 14.4).
 *
 * The channel is a build setting: `VITE_LUMEN_CHANNEL=beta` for the beta
 * web deployment and beta desktop builds, stable otherwise. A flag in stage
 * "beta" is on in beta builds and off in stable ones, until a later release
 * promotes it (src/flags/flags.json, checked by `npm run flags:check`).
 *
 * Everything is local: no remote config, no request, no identifier. A user
 * can turn any flag on or off for themselves (Settings → Feature flags);
 * that choice lives in this browser's storage and wins over the channel.
 */

import registry from "./flags.json";

export type Channel = "stable" | "beta";
export type FlagStage = "beta" | "stable";

export interface FlagDef {
  id: string;
  stage: FlagStage;
  since: { beta: string; stable?: string };
}

export const FLAGS: readonly FlagDef[] = (registry as { flags: FlagDef[] }).flags;
const BY_ID = new Map(FLAGS.map((f) => [f.id, f]));

const STORAGE_KEY = "lumen-flags";
export const FLAGS_CHANGED = "lumen-flags-changed";

/** The build's channel. Anything but "beta" is stable. */
export function buildChannel(env: { VITE_LUMEN_CHANNEL?: string } | undefined = import.meta.env as { VITE_LUMEN_CHANNEL?: string } | undefined): Channel {
  return (env?.VITE_LUMEN_CHANNEL ?? "").trim().toLowerCase() === "beta" ? "beta" : "stable";
}

/** On or off by default in a channel. */
export const defaultFor = (flag: FlagDef, channel: Channel): boolean => flag.stage === "stable" || channel === "beta";

type Overrides = Record<string, boolean>;

/** The user's own choices: known flags with boolean values only. */
export function readOverrides(storage: Pick<Storage, "getItem"> | null = safeStorage()): Overrides {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const data = raw ? (JSON.parse(raw) as unknown) : null;
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const out: Overrides = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) if (BY_ID.has(k) && typeof v === "boolean") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export interface FlagState {
  flag: FlagDef;
  enabled: boolean;
  /** Where the value comes from: the user's own choice, or the channel's default. */
  source: "override" | "channel";
  channelDefault: boolean;
}

export function flagState(id: string, opts: { channel?: Channel; overrides?: Overrides } = {}): FlagState | null {
  const flag = BY_ID.get(id);
  if (!flag) return null;
  const channel = opts.channel ?? buildChannel();
  const overrides = opts.overrides ?? readOverrides();
  const channelDefault = defaultFor(flag, channel);
  if (id in overrides) return { flag, enabled: overrides[id], source: "override", channelDefault };
  return { flag, enabled: channelDefault, source: "channel", channelDefault };
}

/** Is a feature on? Unknown ids are off, so a removed flag can't switch anything on. */
export function isEnabled(id: string, opts: { channel?: Channel; overrides?: Overrides } = {}): boolean {
  return flagState(id, opts)?.enabled ?? false;
}

/** Turn a flag on or off for this user; `null` goes back to the channel's default. */
export function setFlag(id: string, value: boolean | null, storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null = safeStorage()): void {
  if (!BY_ID.has(id)) return;
  const next = readOverrides(storage);
  if (value === null) delete next[id];
  else next[id] = value;
  try {
    if (Object.keys(next).length) storage?.setItem(STORAGE_KEY, JSON.stringify(next));
    else storage?.removeItem(STORAGE_KEY);
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(FLAGS_CHANGED, { detail: { id } }));
}

export function resetFlags(storage: Pick<Storage, "removeItem"> | null = safeStorage()): void {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to reset */
  }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(FLAGS_CHANGED, { detail: { id: null } }));
}
