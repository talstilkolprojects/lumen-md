/**
 * Where this device keeps its classroom assignments (plan W5.21): IndexedDB,
 * one record per assignment. The private keys are stored as non-extractable
 * CryptoKeys (IndexedDB keeps them as they are): code running in the app can
 * use them, but no code can read their bytes out.
 */

import { createStore, del, get, set, values, type UseStore } from "idb-keyval";
import type { Assignment } from "./classroom";

let db: UseStore | null = null;
const store = () => (db ??= createStore("lumen-classroom", "assignments"));

export async function listAssignments(): Promise<Assignment[]> {
  const all = (await values(store())) as Assignment[];
  return all.sort((a, b) => (b.role === "teacher" ? b.created : b.joined) - (a.role === "teacher" ? a.created : a.joined));
}

/** A teacher who opens their own link on the same device keeps both records. */
const keyOf = (role: Assignment["role"], id: string) => `${role}:${id}`;

export async function getAssignment(role: Assignment["role"], id: string): Promise<Assignment | undefined> {
  return (await get(keyOf(role, id), store())) as Assignment | undefined;
}

export async function saveAssignment(a: Assignment): Promise<void> {
  await set(keyOf(a.role, a.id), a, store());
}

export async function removeAssignment(a: Assignment): Promise<void> {
  await del(keyOf(a.role, a.id), store());
}
