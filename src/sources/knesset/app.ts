/**
 * The app side of Knesset sources (plan W7.5): the vault as storage, the
 * consented ledger fetch behind a confirmation, and the "Ask the law"
 * index over saved laws. Loaded on first use from the palette, so none of
 * it is in the startup bundle.
 */
import "./strings";
import { isOPFSAvailable, listWorkspace, readWorkspaceFile, workspaceHasFile, writeWorkspaceFile } from "../../storage/workspace";
import { isSourceEnabled, withGate } from "../open/gate";
import { lawMentionsIn, matchLaw } from "./lawNames";
import { searchBills, type Bill, type Law } from "./odata";
import { findTurn, parseProtocol, parseProtocolHeader, protocolQuote } from "./protocol";
import { askTheLaw, lawCitation, lookupLaw, saveBill, saveLaw, savedLaws, type LawAnswer, type LawLookup, type NoteStorage } from "./store";

export { lawCitation, lawMentionsIn, matchLaw };

export const LEDGER_REASON = "Knesset records (OData): the law or bill name only";

const vault: NoteStorage = {
  async read(path) {
    if (!isOPFSAvailable()) return null;
    try {
      return (await workspaceHasFile(path)) ? await readWorkspaceFile(path) : null;
    } catch {
      return null;
    }
  },
  write: (path, content) => writeWorkspaceFile(path, content),
  async list(dir) {
    if (!isOPFSAvailable()) return [];
    return (await listWorkspace()).map((f) => f.path).filter((p) => p.startsWith(`${dir}/`));
  },
};

const changed = () => window.dispatchEvent(new Event("lumen-workspace-changed"));

/** The law a name refers to: a saved copy with no request, otherwise the Knesset after `confirm`. null when declined. */
export function findLaw(name: string, confirm: () => Promise<boolean>): Promise<LawLookup | null> {
  return withGate({ source: "knesset", reason: LEDGER_REASON, confirm, enabled: () => isSourceEnabled("knesset") }, async (f) => lookupLaw(name, { storage: vault, fetch: f }));
}

export function findBills(name: string, confirm: () => Promise<boolean>): Promise<Bill[] | null> {
  return withGate({ source: "knesset", reason: LEDGER_REASON, confirm, enabled: () => isSourceEnabled("knesset") }, (f) => searchBills(name, f));
}

/** The user asked for an offline copy. Returns its path, or null when there is no vault. */
export async function keepLaw(law: Law, text = ""): Promise<string | null> {
  if (!isOPFSAvailable()) return null;
  const path = await saveLaw(law, vault, text);
  changed();
  return path;
}

export async function keepBill(bill: Bill): Promise<string | null> {
  if (!isOPFSAvailable()) return null;
  const path = await saveBill(bill, vault);
  changed();
  return path;
}

/** The laws saved in the vault (no request). */
export const savedLawsInVault = () => savedLaws(vault);

/** "Ask the law": the saved laws only, searched here; nothing is sent. */
export async function ask(question: string): Promise<LawAnswer[]> {
  return askTheLaw(question, await savedLaws(vault));
}

/** A protocol quote from the open note (a protocol's text) and the selected words; null when the words are not in a speaker's turn. */
export function quoteFromProtocol(protocolText: string, excerpt: string): string | null {
  const turn = findTurn(parseProtocol(protocolText), excerpt);
  if (!turn) return null;
  return protocolQuote(turn, excerpt, parseProtocolHeader(protocolText));
}
