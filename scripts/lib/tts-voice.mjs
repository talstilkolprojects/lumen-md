/**
 * Plan W2.6: what it takes to list a neural Hebrew voice, checked before it
 * is listed (scripts/tts-voice.mjs). Pure functions; the CLI reads files.
 *
 * A voice is listed (src/ai/tts/voices.ts HEBREW_VOICES) only when:
 * - its config is a Piper config that covers every phoneme the G2P writes
 *   (else words would lose sounds silently) and the pauses it keeps;
 * - its two files are pinned: an https URL at a fixed revision, the size and
 *   the sha256 of the files that were checked;
 * - the licence of the weights AND of the training data allow shipping it
 *   (decision 15.10): no non-commercial, no-derivatives or GPL terms, and
 *   nothing that matches a forbidden registry entry (models/registry.json).
 */
import { createHash } from "node:crypto";

export const PAUSES = [" ", ",", ".", "?", "!"];
const BAD_LICENCE = /\b(?:NC|non[- ]?commercial|ND|no[- ]?deriv|GPL|AGPL|research[- ]only|personal[- ]use)\b/i;

/** Problems with a Piper voice config for this G2P (empty: usable). */
export function configProblems(config, phonemes) {
  const c = config ?? {};
  const out = [];
  if (!c.audio || typeof c.audio.sample_rate !== "number" || c.audio.sample_rate < 8000) out.push("audio.sample_rate is missing or below 8000");
  const map = c.phoneme_id_map;
  if (!map || typeof map !== "object") return [...out, "phoneme_id_map is missing"];
  for (const k of ["^", "$", "_"]) if (!Array.isArray(map[k])) out.push(`phoneme_id_map lacks "${k}" (BOS, EOS or pad)`);
  const missing = phonemes.filter((p) => !Array.isArray(map[p]));
  if (missing.length) out.push(`the voice has no id for ${missing.length} of the G2P's phonemes: ${missing.join(" ")}`);
  const pauses = PAUSES.filter((p) => !Array.isArray(map[p]));
  if (pauses.length) out.push(`the voice has no id for the pause marks ${pauses.map((p) => JSON.stringify(p)).join(" ")}`);
  if (c.num_speakers !== undefined && (!Number.isInteger(c.num_speakers) || c.num_speakers < 1)) out.push("num_speakers is not a positive whole number");
  return out;
}

/** An https URL that names a fixed revision (a 40-hex commit, as Hugging Face's /resolve/<sha>/, or a release tag path). */
export function isPinnedUrl(url) {
  if (typeof url !== "string" || !/^https:\/\/[^/\s]+\/\S+$/.test(url)) return false;
  return /\/resolve\/[0-9a-f]{40}\//.test(url) || /\/releases\/download\/[^/]+\//.test(url) || /\/raw\/[0-9a-f]{40}\//.test(url);
}

/** Problems with a voice's licence and identity against the registry (empty: may be listed). */
export function licenceProblems(v, registry) {
  const out = [];
  if (!v.license || !v.dataLicense) out.push("both the weights' licence and the training data's licence are needed (decision 15.10)");
  for (const [what, l] of [["weights", v.license], ["training data", v.dataLicense]]) if (l && BAD_LICENCE.test(l)) out.push(`the ${what}' licence (${l}) does not allow shipping it`);
  if (!v.attribution) out.push("an attribution line is needed");
  const hay = [v.id, v.source, v.attribution, v.modelUrl, v.configUrl].join(" ").toLowerCase();
  for (const e of registry?.models ?? []) {
    if (e.class !== "forbidden") continue;
    const pats = [e.id, ...(e.match ?? [])].map((x) => String(x).toLowerCase()).filter((x) => x.length >= 4);
    const hit = pats.find((p) => hay.includes(p));
    // A forbidden entry's own source (a repository or an author's page) covers every file under it.
    const src = typeof e.source === "string" && /^https:\/\/[^/]+\/[^/]+/.test(e.source) ? e.source.replace(/\/+$/, "").toLowerCase() + "/" : null;
    const under = !!src && [v.modelUrl, v.configUrl, v.source].some((u) => typeof u === "string" && (u.toLowerCase() + "/").startsWith(src));
    if (hit || under) out.push(`it matches the forbidden registry entry "${e.id}" (${e.license})`);
  }
  const listed = registry?.models?.find((e) => e.id === v.id);
  if (listed && listed.class !== "allowed") out.push(`the registry lists "${v.id}" as ${listed.class}`);
  return out;
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** The HEBREW_VOICES entry for voices.ts. */
export function voiceSnippet(v, files) {
  return `  {
    id: ${JSON.stringify(v.id)},
    language: "he",
    license: ${JSON.stringify(`${v.license} (weights), ${v.dataLicense} (training data)`)},
    attribution: ${JSON.stringify(v.attribution)},
    model: { url: ${JSON.stringify(v.modelUrl)}, bytes: ${files.model.bytes}, sha256: ${JSON.stringify(files.model.sha256)} },
    config: { url: ${JSON.stringify(v.configUrl)}, bytes: ${files.config.bytes}, sha256: ${JSON.stringify(files.config.sha256)} },${v.speaker !== undefined ? `\n    speaker: ${Number(v.speaker)},` : ""}
  },`;
}

/** The models/registry.json entry (verified only after a person read both licences). */
export function registryEntry(v, files) {
  return {
    id: v.id,
    kind: "tts",
    source: v.source ?? v.modelUrl,
    license: `${v.license}; training data: ${v.dataLicense}`,
    class: "allowed",
    commercial: "yes",
    attribution: v.attribution,
    size: `${Math.round(((files.model.bytes + files.config.bytes) / 1e6) * 10) / 10} MB`,
    runs: "browser",
    delivery: "download-on-consent",
    verified: false,
    notes: "Hebrew read-aloud voice (plan W2.6). Set verified: true once a person has read the weights' and the data's licence.",
  };
}
