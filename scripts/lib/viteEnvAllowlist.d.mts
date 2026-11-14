/** Types for ./viteEnvAllowlist.mjs (plan W4.4). */
export interface ViteEnvAllowlist {
  names: Record<string, string>;
  prefixes: Record<string, string>;
}
export const ALLOWLIST_PATH: string;
export const CANARY_VALUE: RegExp;
export function loadAllowlist(path?: string): ViteEnvAllowlist;
export function isAllowedViteName(name: string, allowlist?: ViteEnvAllowlist): boolean;
export function checkViteEnv(
  env: Record<string, string | undefined>,
  allowlist?: ViteEnvAllowlist,
): { allowed: string[]; disallowed: string[] };
export function formatViteEnvError(disallowed: string[]): string;
