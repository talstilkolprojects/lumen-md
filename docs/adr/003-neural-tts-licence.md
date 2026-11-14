# ADR-003: Neural read-aloud: what is allowed until decision 15.10(1)

**Status:** Proposed (spike for plan 6.2; the decision belongs to the owner, 15.10(1))
**Date:** 2026-10-24
**Context:** Plan 6.2 wants an on-device voice better than the system's
`speechSynthesis`, with zero GPL components in the bundle (gate 0.10) and
zero network requests after the download. Read-aloud (`⌘K → Read aloud`,
`src/ai/tts.ts`) uses the system's voices today. It reads sentence by
sentence, picks a voice per sentence by local language detection (6.5), and
highlights the sentence being read as a decoration, never by changing the
selection (6.2.4).

## What was verified (24.10)

| Component | Licence on npm / model card | What it actually ships | Verdict |
|---|---|---|---|
| `kokoro-js` 1.2.1 | Apache-2.0 | depends on `phonemizer` ^1.2.1 and `@huggingface/transformers` ^3.5.1 | Apache itself, but it pulls in `phonemizer` |
| `phonemizer` 1.2.1 (tarball sha256 `12f9f358…ee22e9`) | **Apache-2.0** in `package.json` and `LICENSE` | `dist/phonemizer.js` (1.3 MB) is eSpeak NG compiled to WebAssembly. The README says "text to phones converter using eSpeak NG", and the bundle contains `espeak-ng-data` and the `espeakEVENT_*` API. eSpeak NG is **GPL-3.0-or-later**. | **GPL in practice.** `scripts/lib/licenses.mjs` already fails it ("bundles eSpeak NG (GPL-3.0)"). |
| Kokoro-82M weights | Apache-2.0 | q8 ONNX ≈ 92 MB | allowed |
| Hebrew voices | — | every public Hebrew voice is trained on SASPEECH (non-commercial); `mms-tts-heb` is CC-BY-NC | **none allowed**: Hebrew stays on system voices (6.2.1) |
| BlueTTS | MIT code; training data has no licence | — | only with the author's written permission (6.2.3, 15.10) |

## The options for 15.10(1)

1. **System voices only** (today's behaviour). Nothing to ship, no GPL, no
   download. Quality depends on the OS.
2. **Kokoro for English, with eSpeak NG as a separate, user-initiated
   download.** The GPL phonemizer would ship as its own worker file, not in
   the bundle, and download only after the user asks and agrees, the same
   way Hspell (AGPL) is handled today (0.10.6). Kokoro's weights come
   through the consent dialog. Whether a separately downloaded GPL worker
   is acceptable is exactly the question in 15.10(1).
3. **Kokoro for English with a non-GPL G2P**: a rule- or dictionary-based
   English phonemizer under MIT/Apache (for example a CMUdict-based G2P;
   CMUdict is BSD-2). This needs Kokoro's phoneme set mapped and its quality
   checked by ear. It is the only route to a neural English voice that
   needs no licence decision, but no finished JS package was verified in
   this spike.

Hebrew is the same under all three options until a licensed voice exists.
Phonikud G2P (6.2.6) would remove the eSpeak dependency for Hebrew but not
the missing voice.

## Decision until 15.10(1)

Option 1, and it is pinned by `src/__tests__/ttsLicence.test.ts`. No package
that bundles eSpeak NG (`phonemizer`, `kokoro-js`, `piper-tts-web`,
`vits-web`) may be in `package.json`, the licence gate must keep failing
them, and read-aloud must use `speechSynthesis` only and make no request. When
the owner decides, 6.2.2 is implemented on that branch: option 2 as a
consent-gated worker download, or option 3 as a lazy chunk.
