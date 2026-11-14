/**
 * Text normalisers for public benchmarks (plan W11.H5, W11.H6).
 *
 * FLEURS-he WER moves by about 12 points with the normaliser (research
 * R2 §1.2: 20.5 % for Whisper-turbo under kol-stream's, 8.9–23.6 % under
 * ours), so a number is only comparable with another measured under the
 * same one. The manifests name the normaliser by id.
 *
 * "ivrit-leaderboard" is a TypeScript port of the normalisation the ivrit.ai
 * Hebrew Transcription Leaderboard applies before WER: remove invisible
 * Unicode controls, remove niqqud and cantillation, then Whisper's
 * BasicTextNormalizer (openai/whisper, MIT: lower-case; drop [..], <..> and
 * (..) spans; NFKC; every mark, symbol and punctuation character becomes a
 * space; collapse spaces).
 *
 * Provenance, honestly: this port was written offline from the published
 * Whisper normaliser and from the ivrit.ai training repository as the
 * author remembers it; the leaderboard's code could not be fetched here.
 * `npm run eval:public -- parity` compares it with the Python original on
 * 50 leaderboard samples (owed, W11.M — see eval/public/README.md); until
 * that passes, results carry `normalizerParity: "unverified"`.
 */

/** Controls the ivrit.ai normaliser deletes (not spaces: they glue nothing). */
const INVISIBLE = /[؜​-‏‪-‮⁦-⁩﻿]/g;
/** Hebrew points and cantillation, U+0591–U+05C7, without maqaf (U+05BE) and the punctuation sof pasuq/paseq/nun hafukha, which are punctuation, not marks. */
const NIQQUD = /[֑-ׇֽֿׁׂׅׄ]/g;

/** openai/whisper `BasicTextNormalizer()(s)` (remove_diacritics=False, split_letters=False). */
export function whisperBasic(s: string): string {
  let t = s.toLowerCase();
  t = t.replace(/[<[][^>\]]*[>\]]/g, "");
  t = t.replace(/\(([^)]+?)\)/g, "");
  t = t.normalize("NFKC").replace(/[\p{M}\p{S}\p{P}]/gu, " ");
  t = t.toLowerCase();
  return t.replace(/\s+/g, " ").trim();
}

export function ivritLeaderboard(s: string): string {
  return whisperBasic(String(s ?? "").replace(INVISIBLE, "").normalize("NFD").replace(NIQQUD, "").normalize("NFC"));
}

export const NORMALIZERS: Record<string, (s: string) => string> = {
  none: (s) => s,
  nfc: (s) => s.normalize("NFC"),
  "whisper-basic": whisperBasic,
  "ivrit-leaderboard": ivritLeaderboard,
};

export function normalizer(id: string): (s: string) => string {
  const f = NORMALIZERS[id];
  if (!f) throw new Error(`unknown normaliser "${id}" (known: ${Object.keys(NORMALIZERS).join(", ")})`);
  return f;
}

/** Normalisers whose parity with the original implementation is not yet checked (see the file comment). */
export const UNVERIFIED_PARITY = new Set(["ivrit-leaderboard"]);
