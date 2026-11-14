// Types for scripts/lib/whats-new.mjs (plan 14.6), for vite.config.ts and the tests.
export declare const LOCALES: string[];
export declare const UNTRANSLATED: string;
export declare const HEADINGS: Record<string, Record<string, string>>;
export interface LocalizedNotes {
  markdown: string;
  translated: boolean;
}
export interface WhatsNew {
  version: string;
  date: string | null;
  notes: Record<string, LocalizedNotes>;
}
export declare function versionSection(changelog: string, version: string): { date: string | null; body: string } | null;
export declare function forReaders(body: string): string;
export declare function localizeHeadings(body: string, locale: string): string;
export declare function whatsNew(version: string, english: string, translations?: Record<string, string>): WhatsNew | null;
export declare function addUntranslated(translation: string, section: string): string;
