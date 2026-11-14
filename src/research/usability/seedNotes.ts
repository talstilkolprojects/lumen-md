/**
 * The practice notes of the self-guided session (plan W4.25): the moderated
 * kit's seed vault (research/usability/seed-vault/), bundled with the
 * session's lazy chunk so the app can write them itself — there is no
 * moderator to import them.
 */
const files = import.meta.glob<string>("../../../research/usability/seed-vault/*.md", { query: "?raw", import: "default", eager: true });

/** File name → text. */
export const SEED_NOTES: Record<string, string> = Object.fromEntries(Object.entries(files).map(([path, text]) => [path.replace(/^.*\//, ""), String(text)]));
