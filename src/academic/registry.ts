/**
 * The academic calendars in the repo (plan W7.8), and the user's choice of
 * institution (localStorage `lumen.academic`). Loaded on first use.
 */
import haifa5787 from "../../data/academic/haifa/5787.json";
import tau5787 from "../../data/academic/tau/5787.json";
import biu5787 from "../../data/academic/biu/5787.json";
import oranim5787 from "../../data/academic/oranim/5787.json";
import { validate, type AcademicYear } from "./calendar";

export const CALENDARS: readonly AcademicYear[] = ([haifa5787, tau5787, biu5787, oranim5787] as unknown as AcademicYear[]).filter((c) => validate(c).length === 0);

const KEY = "lumen.academic";

export function chosen(storage: Pick<Storage, "getItem"> | null = safe()): AcademicYear | null {
  try {
    const raw = storage?.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as { institution?: string; year?: number }) : null;
    return CALENDARS.find((c) => c.institution.id === v?.institution && c.year === v?.year) ?? null;
  } catch {
    return null;
  }
}

export function choose(c: AcademicYear | null, storage: Pick<Storage, "setItem" | "removeItem"> | null = safe()): void {
  try {
    if (c) storage?.setItem(KEY, JSON.stringify({ institution: c.institution.id, year: c.year }));
    else storage?.removeItem(KEY);
  } catch {
    /* private mode: the choice lasts for this session only */
  }
}

function safe(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
