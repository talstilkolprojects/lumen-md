/**
 * The app side of Sefaria sources (plan W5.1): the vault as storage, the
 * privacy ledger's consented fetch, and the notes index. Loaded on first
 * use from the palette, so none of it is in the startup bundle.
 */
import { ledgerFetch } from "../../ai/privacyLedger";
import { isOPFSAvailable, listWorkspace, readWorkspaceFile, workspaceHasFile, writeWorkspaceFile } from "../../storage/workspace";
import type { Passage } from "./client";
import { parseSourceRef, sourceRefsIn, type SourceRef } from "./refs";
import { lookupPassage, notesCiting, parseSourceNote, quoteBlock, savePassage, type LookupResult, type SourceStorage } from "./store";

export { parseSourceRef, sourceRefsIn, quoteBlock };

export const LEDGER_REASON = "Jewish sources (Sefaria): the reference only";

const vaultStorage: SourceStorage = {
  async read(path) {
    if (!isOPFSAvailable()) return null;
    try {
      return (await workspaceHasFile(path)) ? await readWorkspaceFile(path) : null;
    } catch {
      return null;
    }
  },
  write: (path, content) => writeWorkspaceFile(path, content),
};

/**
 * The passage for `ref`: the saved copy when there is one (no request and
 * no question), otherwise from Sefaria once `confirm` says yes. null when
 * the user declined.
 */
export async function lookup(ref: SourceRef, confirm: () => Promise<boolean>): Promise<LookupResult | null> {
  let asked: boolean | null = null;
  const consentedFetch = ledgerFetch({ force: { category: "cloud-text", reason: LEDGER_REASON }, consent: true });
  const gated: typeof fetch = async (input, init) => {
    asked ??= await confirm();
    if (!asked) throw new DeclinedError();
    return consentedFetch(input, init);
  };
  try {
    return await lookupPassage(ref, { storage: vaultStorage, fetch: gated });
  } catch (e) {
    if (e instanceof DeclinedError) return null;
    throw e;
  }
}

class DeclinedError extends Error {}

/** The user asked for an offline copy. Returns its path, or null when there is no vault. */
export async function saveForOffline(p: Passage): Promise<string | null> {
  if (!isOPFSAvailable()) return null;
  const path = await savePassage(p, vaultStorage);
  window.dispatchEvent(new Event("lumen-workspace-changed"));
  return path;
}

/** Every note in the vault that cites this verse (read locally; nothing is sent). */
export async function notesOnVerse(ref: SourceRef): Promise<string[]> {
  if (!isOPFSAvailable()) return [];
  const files = (await listWorkspace()).filter((f) => f.path.endsWith(".md"));
  const notes: Array<{ path: string; content: string }> = [];
  for (const f of files) {
    try {
      notes.push({ path: f.path, content: await readWorkspaceFile(f.path) });
    } catch {
      /* unreadable: skip */
    }
  }
  return notesCiting(ref, notes);
}

/** The reference of a saved source note (when the open note is one). */
export function refOfSourceNote(markdown: string): SourceRef | null {
  return parseSourceNote(markdown)?.ref ?? null;
}
