// Types for scripts/models/mirror.mjs (plan W4.14), for the tests.
export interface MirrorModel {
  id: string;
  class?: string;
  delivery?: string;
  source?: string;
  license?: string;
  attribution?: string;
  hosting?: { hf?: string; revision?: string | null; cache?: string; dtypes?: string[]; lib?: string; tag?: string };
  files?: Array<{ path: string; sha256: string; bytes: number }>;
}
export interface MirrorOptions {
  mode: "check" | "pin" | "upload" | "verify" | null;
  strict: boolean;
  all: boolean;
  only: string[] | null;
  includeConditional: boolean;
  dryRun: boolean;
  deep: boolean;
  mirror: string | null;
  fromDir: string | null;
}
export function fileDtype(path: string): string;
export function keepPath(model: MirrorModel, path: string): boolean;
export function parseArgs(argv: string[]): MirrorOptions;
export function selectModels<M extends MirrorModel>(models: M[], opts: Partial<MirrorOptions>): M[];
export function releaseNotes(model: MirrorModel): string;
