// nspell 2.1 ships no types (plan 6.10 uses only these four calls).
declare module "nspell" {
  interface NSpell {
    correct(word: string): boolean;
    suggest(word: string): string[];
    add(word: string): NSpell;
    personal(dic: string): NSpell;
  }
  function nspell(aff: string | Uint8Array, dic?: string | Uint8Array): NSpell;
  export default nspell;
}

// Built by the lumen-dictionary-en plugin in vite.config.ts (plan 6.10):
// the dictionary itself under Vitest, null in a dev or production build.
declare module "virtual:lumen-dictionary-en" {
  export const inline: { aff: string; dic: string } | null;
}
