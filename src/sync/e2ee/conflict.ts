/**
 * Conflict resolution for the encrypted sync (plan 3.4, step 3).
 *
 * The engine settles every case it can without asking: one side changed,
 * both sides made the same change, or an edit raced a deletion (the edit
 * wins — a deletion never destroys an edit it did not see). Only "both sides
 * edited the same file differently" reaches a `ConflictResolver`. In the app
 * that is the existing three-way ConflictDialog for text and "keep both" for
 * binary files; tests plug in their own.
 */

import { fromUtf8, utf8 } from "./bytes";
import "./strings";

export interface ConflictInput {
  path: string;
  /** The common ancestor, when the device still has it. */
  base: Uint8Array | null;
  local: Uint8Array;
  remote: Uint8Array;
}

/**
 *   content  — the path gets `data` (a merge);
 *   local    — keep this device's version;
 *   remote   — take the other device's version;
 *   keepBoth — keep this device's version at the path and the other one as a conflict copy next to it;
 *   hold     — decide later: nothing changes on either side, and the next round asks again.
 */
export type ConflictResolution =
  | { kind: "content"; data: Uint8Array }
  | { kind: "local" }
  | { kind: "remote" }
  | { kind: "keepBoth" }
  | { kind: "hold" };

export type ConflictResolver = (c: ConflictInput) => Promise<ConflictResolution>;

/** The bytes as text, or null when they are not UTF-8 text (a binary file). */
export function asText(b: Uint8Array): string | null {
  try {
    const s = fromUtf8(b);
    return s.includes("\u0000") ? null : s;
  } catch {
    return null;
  }
}

/** Never loses either side and never asks: the default without a UI. */
export const keepBothResolver: ConflictResolver = async () => ({ kind: "keepBoth" });

/**
 * The app's resolver: the three-way ConflictDialog (loaded on demand) for
 * text, "keep both" for binary files. Cancelling the dialog holds the file
 * until the next round.
 */
export const dialogResolver: ConflictResolver = async (c) => {
  const local = asText(c.local);
  const remote = asText(c.remote);
  if (local === null || remote === null) return { kind: "keepBoth" };
  const base = (c.base && asText(c.base)) ?? "";
  const [{ openConflictDialog }, { t }] = await Promise.all([import("../cloud/ConflictDialog"), import("../../i18n")]);
  const choice = await openConflictDialog({
    path: c.path,
    base,
    local,
    remote,
    labels: {
      title: t("e2ee.conflict.title", { path: c.path }),
      description: t("e2ee.conflict.body"),
      local: t("external.conflict.mine"),
      remote: t("external.conflict.theirs"),
      takeLocal: t("external.conflict.takeMine"),
      takeRemote: t("external.conflict.takeTheirs"),
      merge: t("external.conflict.merge"),
      cancel: t("e2ee.conflict.later"),
    },
  });
  if (!choice) return { kind: "hold" };
  if (choice.kind === "merged") return { kind: "content", data: utf8(choice.content) };
  return { kind: choice.kind };
};

/**
 * `dir/name (conflict <tag>).ext`, or with " 2", " 3"… until `taken` says
 * the name is free.
 */
export function conflictCopyPath(path: string, tag: string, taken: (p: string) => boolean): string {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const file = path.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : "";
  for (let i = 1; ; i++) {
    const p = `${dir}${stem} (conflict ${tag}${i > 1 ? ` ${i}` : ""})${ext}`;
    if (!taken(p)) return p;
  }
}
