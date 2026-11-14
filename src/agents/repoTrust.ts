/**
 * "Trust this repo" for agent writes in a cloned repository (plan W1.33).
 *
 * Notes from a git clone or pull are outside content (`provenance.ts`): an
 * agent that read them asks before a write is staged (`runtime.ts`). The
 * user can trust a repository they own (Settings → Trusted repositories).
 * Its notes stay outside content (still delimited in prompts, still
 * recorded on the run), but a write proposed in a run whose only outside
 * content comes from trusted repositories is staged without that
 * question. It still waits for review, and network calls still ask.
 *
 * Conservative by default: nothing is trusted, an unreadable store trusts
 * nothing, and only a git record counts. A clipped page, an import,
 * `untrusted: true` in a note, a web result or an unknown origin never do.
 *
 * Stored on this device only. Each trust is bound to the repository's
 * provenance record (its folder and the time it was recorded), so it
 * lapses by itself when that record changes: a fresh clone into the folder
 * writes a new record, a rename or move carries the record to another
 * name, and a folder moved onto the name brings its own record. Nothing on
 * the startup path has to know about trust.
 */
import { snapshotRecords } from "./provenance";

const KEY = "lumen.agents.trustedRepos";

/** The provenance reasons `sync/git.ts` records for a clone and a pull. */
const GIT_REASONS = new Set(["cloned from git", "pulled from git"]);
/** How `untrustedSourcesOfNote` reports a note under such a record. */
const GIT_SOURCE = /^(?:cloned|pulled) from git \((.+)\)$/;

type Trusted = Record<string, { at: number }>;

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function readTrusted(): Trusted {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Trusted) : {};
  } catch {
    return {};
  }
}

/** The git provenance record of a repository folder, or null (none, another origin, or unreadable). */
function gitRecord(repo: string): { reason: string; at: number } | null {
  try {
    const records = snapshotRecords();
    const rec = own(records, repo) ? records[repo] : undefined;
    return rec && GIT_REASONS.has(rec.reason) ? rec : null;
  } catch {
    return null;
  }
}

/** True when the user trusts `repo` and it is still the repository they trusted. */
export function isRepoTrusted(repo: string): boolean {
  const t = readTrusted();
  if (!own(t, repo)) return false;
  const rec = gitRecord(repo);
  return !!rec && t[repo]?.at === rec.at;
}

/** The repository folders the user trusts now, sorted. */
export function listTrustedRepos(): string[] {
  return Object.keys(readTrusted()).filter(isRepoTrusted).sort();
}

/**
 * Turn "trust this repo" on or off. Turning it on needs the folder's git
 * provenance record (a repository cloned or pulled in this browser) and
 * throws without one; either direction throws when it can't be stored.
 */
export function setRepoTrusted(repo: string, trusted: boolean): void {
  const t = readTrusted();
  if (trusted) {
    const rec = gitRecord(repo);
    if (!rec) throw new Error(`"${repo}" is not a repository cloned in this browser`);
    t[repo] = { at: rec.at };
  } else if (own(t, repo)) {
    delete t[repo];
  } else {
    return;
  }
  localStorage.setItem(KEY, JSON.stringify(t));
}

/**
 * The trusted repository a run's untrusted source comes from, or null.
 * Only a git source ("cloned from git (repo/x.md)") of a note inside a
 * trusted repository counts. `untrustedSourcesOfNote` reports the record
 * nearest the note, so a clip or import moved into the repository shows its
 * own origin instead and is not covered.
 */
export function trustedRepoOfSource(source: string): string | null {
  const path = GIT_SOURCE.exec(source)?.[1];
  if (!path) return null;
  let records: ReturnType<typeof snapshotRecords>;
  try {
    records = snapshotRecords();
  } catch {
    return null;
  }
  // The record nearest the note decides, as in `untrustedSourcesOfNote`: a
  // repository cloned inside a trusted one is judged on its own.
  const parts = path.split("/");
  for (let i = parts.length; i > 0; i--) {
    const anc = parts.slice(0, i).join("/");
    if (anc && own(records, anc)) return isRepoTrusted(anc) ? anc : null;
  }
  return null;
}

/** True when a run has outside content and every piece of it comes from a trusted repository. */
export function taintIsTrusted(sources: readonly string[]): boolean {
  return sources.length > 0 && sources.every((s) => trustedRepoOfSource(s) !== null);
}
