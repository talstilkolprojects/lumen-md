/**
 * The one way an open source reaches the network (plans W7.5–W7.7, W7.24).
 *
 *  - Nothing is sent until the user acts: every request goes through a fetch
 *    that asks `confirm` first (once per action) and throws `DeclinedError`
 *    when the user says no — nothing leaves the device then.
 *  - Every request that is sent is consented traffic in the privacy ledger
 *    (`ledgerFetch` with `consent: true`), under the source's own reason.
 *  - A source the user turned off sends nothing at all (`SourceOffError`).
 *
 * Sefaria (W5.1) predates this file and keeps the same pattern in
 * sources/sefaria/app.ts.
 */
import { ledgerFetch } from "../../ai/privacyLedger";

export class DeclinedError extends Error {
  constructor() {
    super("declined");
    this.name = "DeclinedError";
  }
}

export class SourceOffError extends Error {
  constructor(readonly source: string) {
    super(`source ${source} is off`);
    this.name = "SourceOffError";
  }
}

export interface GateOptions {
  /** The ledger's reason for this source ("Knesset records (OData): the query only"). */
  reason: string;
  /** Asks the user; called at most once per gated fetch, and only when a request is about to be made. */
  confirm: () => Promise<boolean>;
  /** False when the user turned this source off: then nothing is sent. */
  enabled?: () => boolean;
  /** The fetch under the gate; the ledger's consented fetch by default (tests pass a stub). */
  base?: typeof fetch;
}

/** A fetch that asks once, then sends through the ledger. */
export function gatedFetch(opts: GateOptions & { source: string }): typeof fetch {
  // The pending answer, not the answer: requests started together (the dialog's search runs its
  // sources in parallel) share one question (review 20, RR20-2).
  let asked: Promise<boolean> | null = null;
  const base = opts.base ?? ledgerFetch({ force: { category: "cloud-text", reason: opts.reason }, consent: true });
  return async (input, init) => {
    if (opts.enabled && !opts.enabled()) throw new SourceOffError(opts.source);
    asked ??= opts.confirm();
    if (!(await asked)) throw new DeclinedError();
    return base(input, init);
  };
}

/** Run `fn` with a gated fetch; null when the user declined. */
export async function withGate<T>(opts: GateOptions & { source: string }, fn: (f: typeof fetch) => Promise<T>): Promise<T | null> {
  try {
    return await fn(gatedFetch(opts));
  } catch (e) {
    if (e instanceof DeclinedError) return null;
    throw e;
  }
}

/** Which open sources the user turned on (W7.24). Sefaria is on by default because W5.1 shipped that way; the rest start off. */
export type OpenSourceId = "sefaria" | "knesset" | "datagov" | "benyehuda";

const KEY = "lumen.openSources";
const DEFAULTS: Record<OpenSourceId, boolean> = { sefaria: true, knesset: false, datagov: false, benyehuda: false };

export function enabledSources(storage: Pick<Storage, "getItem"> | null = safeStorage()): Record<OpenSourceId, boolean> {
  try {
    const raw = storage?.getItem(KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<Record<OpenSourceId, boolean>>) : {};
    return { ...DEFAULTS, ...Object.fromEntries(Object.entries(saved).filter(([, v]) => typeof v === "boolean")) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setSourceEnabled(id: OpenSourceId, on: boolean, storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage()): void {
  const next = { ...enabledSources(storage), [id]: on };
  try {
    storage?.setItem(KEY, JSON.stringify(next));
  } catch {
    // why: storage is blocked or full (private mode, quota): the setting holds for this session only
    /* private mode: the choice lasts for this session only */
  }
}

export function isSourceEnabled(id: OpenSourceId): boolean {
  return enabledSources()[id];
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
