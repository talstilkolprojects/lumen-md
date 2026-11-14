/** Every generator's token forms: `TK<n>Q` (tags), `Q<4>Z` (blocks), `Z<n>Z` (footnotes, containers). */
export const TOKEN = /TK\d+Q|Q[0-9a-z]{4}Z|Z\d+Z/g;

export const tokensIn = (s: string): Set<string> => new Set([...s.matchAll(TOKEN)].map((m) => m[0]));
