export interface BuildManifest { v: 1; commit: string; lockfile: string; node: string; host: string; builtAt: string; files: Record<string, string> }
export interface Comparison { comparable: boolean; reason?: string; commit?: string; total?: number; same?: number; differ?: string[]; onlyA?: string[]; onlyB?: string[]; identical?: boolean }
export interface HistoryEntry { commit: string; date: string; identical: boolean }
export const MANIFEST_PATH: string;
export const PREDICATE_TYPE: string;
export const STREAK_TARGET: number;
export function manifestOf(entries: Array<{ path: string; hash: string }>, meta: Omit<BuildManifest, "v" | "files">): BuildManifest;
export function compareManifests(a: BuildManifest, b: BuildManifest): Comparison;
export function withResult(history: HistoryEntry[], entry: HistoryEntry): HistoryEntry[];
export function streak(history: HistoryEntry[]): number;
export function attestation(result: Comparison, a: BuildManifest, b: BuildManifest): null | { _type: string; subject: Array<{ name: string; digest: { sha256: string } }>; predicateType: string; predicate: Record<string, unknown> };
export function reportLines(result: Comparison, history: HistoryEntry[]): string[];
