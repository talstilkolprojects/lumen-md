/**
 * A vault's identity (2.80, Codex P2 on #235): what its version history
 * (and other state kept by path) is filed under, so two vaults that both
 * have `notes/a.md` never see each other's. A location keeps its identity;
 * a move hands the source's identity to the target, so the history follows
 * the notes. The first vault ever seen gets "", which owns the history
 * written before identities. Split out of location.ts, which passes in its
 * key-value store and its location comparison.
 */
import { log } from "../../lib/logger";
import { setHistoryVault } from "../history";

export const IDS_KEY = "lumen-vault-ids";

interface IdStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

interface VaultIdentity<L> {
  loc: L;
  id: string;
}

let activeId: string | null = null;

/** The identity of the vault that is open now (null: none, or it could not be read). */
export function activeVaultId(): string | null {
  return activeId;
}

function newVaultId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return Array.from(c ? c.getRandomValues(new Uint8Array(16)) : [], (b) => b.toString(16).padStart(2, "0")).join("") || `${Date.now()}-${Math.random()}`;
}

/** The identity of `loc`, given one the first time it is seen. */
export async function identityOf<L>(kv: IdStore, same: (a: L, b: L) => Promise<boolean>, loc: L): Promise<string> {
  const ids = await kv.get<VaultIdentity<L>[]>(IDS_KEY);
  for (const e of ids ?? []) if (await same(e.loc, loc)) return e.id;
  const id = ids === undefined ? "" : newVaultId();
  await kv.set(IDS_KEY, [...(ids ?? []), { loc, id }]);
  return id;
}

/** From now on `loc` is the vault `id` (the target of a move). */
export async function adoptIdentity<L>(kv: IdStore, same: (a: L, b: L) => Promise<boolean>, loc: L, id: string): Promise<void> {
  const kept: VaultIdentity<L>[] = [];
  for (const e of (await kv.get<VaultIdentity<L>[]>(IDS_KEY)) ?? []) if (!(await same(e.loc, loc))) kept.push(e);
  await kv.set(IDS_KEY, [...kept, { loc, id }]);
}

/** `identityOf`, or null (no history at all) when it cannot be read. */
export async function identityOrNull<L>(kv: IdStore, same: (a: L, b: L) => Promise<boolean>, loc: L): Promise<string | null> {
  try {
    return await identityOf(kv, same, loc);
  } catch (err) {
    log.warn("the vault identity could not be read; version history is off until it can", err);
    return null;
  }
}

/** The vault `id` is the open one: history reads and writes go to it. */
export function enterIdentity(id: string | null): void {
  activeId = id;
  setHistoryVault(id);
}

/** @internal tests */
export function __resetIdentity(): void {
  activeId = null;
  setHistoryVault("");
}
