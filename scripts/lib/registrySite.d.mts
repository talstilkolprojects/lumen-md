/** Types of registrySite.mjs (plan W6.35). */
export declare const SITE_SCHEMA: number;
export declare const PAGES_LIMITS: { files: number; fileBytes: number; headerRules: number; headerLineChars: number };
export declare function sha256(data: string | Uint8Array): string;
export interface SiteSource {
  index: { plugins: { id: string; versions: { version: string; path: string; sha256: string }[] }[] };
  scan: { scanner: number; results: { id: string; version: string; passed: boolean; grade?: string; score?: number; findings?: unknown[] }[] };
  read(path: string, file: string): Buffer | string;
  commit?: string | null;
}
export declare function buildSite(source: SiteSource): {
  files: Map<string, Buffer>;
  index: { schema: number; source: string | null; plugins: { id: string; name: string; latest: string; versions: { version: string; sha256: string; files: Record<string, { sha256: string; bytes: number }> }[] }[] };
  skipped: string[];
};
export declare function pagesProblems(files: Map<string, Buffer>): string[];
export declare function verifySite(opts: {
  get(path: string): Promise<Buffer | null>;
  scanVersion(v: { manifest: string; main: string; ui?: string }): Promise<{ passed: boolean; id: string; version: string; findings: { rule: string }[] }>;
}): Promise<{ ok: boolean; problems: string[]; versions: number }>;
