/** Types for ./i18n-files.mjs (the translation files' layout, plan 0.3). */
export type Strings = Record<string, string>;
export interface KeyEntry {
  key: string;
  en: string;
  vars: string[];
}
export interface KeyFile {
  version: number;
  domain: string;
  source: string;
  entries: KeyEntry[];
}
export const ROOT: string;
export const LOCALES_DIR: string;
export const KEYS_DIR: string;
export const SOURCE_LOCALE: string;
export const DOMAINS: Record<string, string[]>;
export const CATCH_ALL: string;
export function domainOf(key: string): string;
export function listLocales(dir?: string): string[];
export function readLocale(lang: string, dir?: string): Strings;
export function sortedObject(map: Strings): Strings;
export function splitByDomain(map: Strings): Record<string, Strings>;
export function formatJson(value: unknown): string;
export function writeLocale(lang: string, map: Strings, dir?: string): string[];
export function placeholders(text: string): string[];
export function buildKeyFiles(en: Strings): Record<string, KeyFile>;
export function readKeyEntries(dir?: string): KeyEntry[];
