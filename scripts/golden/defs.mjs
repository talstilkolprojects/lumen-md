/**
 * The ten golden sets of plan 7.1 / appendix 20.3: what each set holds,
 * where every part comes from, its licence and the evidence for it. The
 * builders (scripts/golden/build.mjs), the SOURCES.md / LICENSE generator
 * and the workflow all read this file, so it is the one place to change a
 * source.
 *
 * Licences were checked on 2026-10-18 in each source's own LICENSE / README
 * at the pinned commit (`evidence`). Sources on Hugging Face could not be
 * reached from the agent container; for those `evidence` says so, and the
 * workflow (scripts/golden/hf_build.py) reads the dataset card's `license:`
 * at run time and refuses to build a part whose card disagrees.
 */

export const VERIFIED_ON = "2026-10-18";

/** Full licence texts: SPDX license-list-data v3.28.0. */
export const SPDX = {
  repo: "spdx/license-list-data",
  tag: "v3.28.0",
  commit: "c4a7237ec8f4654e867546f9f409749300f1bf4c",
  texts: {
    "Apache-2.0": "074e6e32c86a4c0ef8b3ed25b721ca23aca83df277cd88106ef7177c354615ff",
    "CC-BY-2.0": "f892996eb4b6f2e54241432ed67b743772224e191ba3a0ae595eb4feca3df4c5",
    "CC-BY-4.0": "d557539df68e771cc1eedcc91d13f70fca930e508d11eedcafa4b15db49e3744",
    "CC-BY-SA-4.0": "cde7883b9050a1104f4ac19a1572aafd6e5d7323b68351aaf51fbf4beba54966",
    "CC0-1.0": "a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499",
  },
};

/** Licences that have no SPDX id: what the LICENSE file says for them. */
export const LICENSE_REFS = {
  "LicenseRef-PublicDomain": {
    title: "Public domain",
    text: "These texts are in the public domain. Project Ben-Yehuda (https://benyehuda.org) states in its dump's README: \"All these works are in the public domain, so you are free to make any use of them, and do not need to ask for permission.\" Credit, as Project Ben-Yehuda asks: \"Project Ben-Yehuda volunteers\", https://benyehuda.org.",
  },
  "LicenseRef-CC-BY-2.0-FR": {
    title: "Creative Commons Attribution 2.0 France",
    text: "Licence: https://creativecommons.org/licenses/by/2.0/fr/ (the Uniform Resource Identifier of the licence, which section 4a of CC BY 2.0 allows in place of a copy). Attribution: each item names its Tatoeba sentence ids; the sentences and their authors are at https://tatoeba.org/sentences/show/<id>.",
  },
  NOASSERTION: {
    title: "No licence (local-only part)",
    text: "This part is never committed or distributed. Only ids and sha256 values are in selection/; `python -I scripts/golden/hf_build.py fetch-local` downloads the text for a local evaluation run into local/, which git ignores, and CI builds the test items.",
  },
};

/** Pinned upstream sources. `files` maps a path in the repo to its sha256. */
export const SRC = {
  ntrex: {
    name: "NTREX-128",
    repo: "MicrosoftTranslator/NTREX",
    commit: "468c6b69c7f6a75d31d4743d9daba2af566cc18d",
    files: {
      "NTREX-128/newstest2019-ref.heb.txt": "3b8cc2c45ab00c3514a9a227910f16e0f025023e7f340286f0e5f95a64e259a7",
      "NTREX-128/newstest2019-src.eng.txt": "389e8f5796c66db4f646dfad33e1ec622d74767af5ef112b42a1f2cd814df3cc",
      "DOCUMENT_IDS.tsv": null,
      "LICENSE.md": "5e436ff8ffbb77d8607220e9bce20c8915d860010feeb6c1ebef5a85688e9b39",
    },
    evidence: "README.md, section \"License\": \"The NTREX-128 data set is released under the CC BY-SA 4.0 license\"; LICENSE.md is the CC BY-SA 4.0 legal code.",
    cite: "Federmann, Kocmi and Xin (2022), NTREX-128 — News Test References for MT Evaluation of 128 Languages, SUMEval. English source: WMT19 newstest2019.",
  },
  benyehuda: {
    name: "Project Ben-Yehuda public-domain dump",
    repo: "projectbenyehuda/public_domain_dump",
    commit: "5e4277fead7b565f32cc4b352abd3565023a77d8",
    files: { "pseudocatalogue.csv": "f8ffb60fd9b770371a3060fedd746dce73a637aa2e2da1fb22b7165a05ea1e40" },
    evidence: "README.md: \"All these works are in the public domain, so you are free to make any use of them, and do not need to ask for permission.\"",
    cite: "Project Ben-Yehuda volunteers, https://benyehuda.org",
  },
  heq: {
    name: "HeQ — Hebrew Question Answering Dataset",
    repo: "NNLP-IL/Hebrew-Question-Answering-Dataset",
    commit: "f46d2ff1b796a95e897530f167ae0d5bed123fe1",
    files: { "data/data v1.1/test v1.1.json": null, LICENSE: null },
    evidence: "LICENSE is the CC BY 4.0 legal code (\"Attribution 4.0 International\"). README: paragraphs come from Hebrew Wikipedia and from Geektime, which allowed sharing them as a public dataset.",
    cite: "HeQ, annotated by Webiks for MAFAT (National Natural Language Processing Plan of Israel); paper: https://u.cs.biu.ac.il/~yogo/heq.pdf",
  },
  bipia: {
    name: "BIPIA — Benchmark of Indirect Prompt Injection Attacks",
    repo: "microsoft/BIPIA",
    commit: "a004b69ec0dd446e0afd461d98cb5e96e120a5d0",
    files: { "benchmark/text_attack_test.json": null, "benchmark/email/test.jsonl": null, LICENSE: null, "NOTICE.md": null },
    evidence: "LICENSE: MIT, Copyright (c) Microsoft Corporation. NOTICE.md: the EmailQA contexts are \"Invoices data in Openai Evals\", MIT, Copyright (c) 2023 OpenAI.",
    cite: "BIPIA: \"Benchmarking and Defending Against Indirect Prompt Injection Attacks on Large Language Models\", https://github.com/microsoft/BIPIA",
  },
  iahltwiki: {
    name: "UD_Hebrew-IAHLTwiki (with nested named entities)",
    repo: "UniversalDependencies/UD_Hebrew-IAHLTwiki",
    commit: "fece0b2599e504aea329d7424561564a2756a630",
    files: { "he_iahltwiki-ud-test.conllu": null, "LICENSE.txt": null },
    evidence: "LICENSE.txt: \"The treebank is licensed under the Creative Commons License Attribution-ShareAlike 4.0 International.\" README metadata: \"License: CC BY-SA 4.0\".",
    cite: "Zeldes, Howell, Ordan and Ben Moshe (2022), A Second Wave of UD Hebrew Treebanking and Cross-Domain Parsing, EMNLP. Israeli Association of Human Language Technologies (IAHLT).",
  },
  faker: {
    name: "Faker (@faker-js/faker), locale he",
    repo: "faker-js/faker",
    commit: "2cb04231a6ace91a59ebe577c653f4ec66478ca3",
    tag: "v10.6.0",
    files: {
      LICENSE: null,
      "src/locales/he/person/first_name.ts": null,
      "src/locales/he/person/last_name.ts": null,
      "src/locales/he/location/city_name.ts": null,
      "src/locales/he/location/street_name_part.ts": null,
    },
    evidence: "LICENSE: MIT (Faker - Copyright (c) 2022-2025, and the faker.js MIT notice it carries); npm @faker-js/faker 10.6.0 declares \"license\": \"MIT\". The data is read from the source files at the release tag; no Faker code is run.",
    cite: "Faker, https://github.com/faker-js/faker",
  },
  xm3600: {
    name: "Crossmodal-3600",
    repo: "google/crossmodal-3600",
    commit: "ad44c380c86cb1240666361caabaf5684507d0ef",
    files: {
      "web-data/captions.zip": "7964f969d39319a96769499b199042015754f8d5607b6aad2d1c2c2e55f5e562",
      "web-data/image_attributions.csv": "288de413d25e9c70dadfd42ee59256aa1082673e615d0eda02c3875fe2b36ecd",
    },
    evidence: "index.html (the project page in the repo): \"The annotations are licensed by Google LLC under CC BY 4.0 license\". web-data/image_attributions.csv: every one of the 3,600 images is https://creativecommons.org/licenses/by/2.0/ (counted), with author, title and Flickr page per image.",
    cite: "Thapliyal, Pont-Tuset, Chen and Soricut (2022), Crossmodal-3600: A Massively Multilingual Multimodal Evaluation Dataset, EMNLP.",
    images: "https://open-images-dataset.s3.amazonaws.com/crossmodal-3600/images.tgz",
  },
  tatoeba: {
    name: "Tatoeba",
    repo: "Tatoeba/tatoeba2",
    commit: "0fbb4506ce071827f85375bd4c8c8f9c7cf23d41",
    exports: "https://downloads.tatoeba.org/exports/",
    evidence: "Tatoeba's own code at the pinned commit: templates/Pages/downloads.php — \"These files are released under CC BY 2.0 FR.\" and \"A part of our sentences are also available under CC0 1.0.\"; docs/database/scripts/weekly_exports.sql builds sentences_CC0.csv with `license = 'CC0 1.0'`. downloads.tatoeba.org itself is not reachable from the agent container, so the workflow downloads the exports.",
    cite: "Tatoeba, https://tatoeba.org",
  },
  nakdimon: {
    name: "Nakdimon test set (tests/new)",
    repo: "elazarg/nakdimon",
    commit: "a06ebfd032548b132ac2da2f5aab1289de5ae5f2",
    evidence: "LICENSE (MIT, Copyright 2022 Elazar Gershuni) covers the code. The test texts under tests/new/expected are modern third-party texts with no licence statement (the companion corpus elazarg/hebrew_diacritized @ 1211c8f has no LICENSE either), so they stay local-only, as the plan says.",
    cite: "Nakdimon, https://github.com/elazarg/nakdimon",
  },
  fonts: {
    name: "Fontsource Hebrew fonts (npm)",
    version: "5.3.0",
    packages: {
      "david-libre": { tgz: "da1257c603cbc2b764a5e528d836be29673cf1de8c0f4746e3ef20e36079372d" },
      "frank-ruhl-libre": { tgz: "5b1c44fc7e969492388256dab15437919a00ee4a2894cdc95605e06ddfd1593e" },
      "miriam-libre": { tgz: "02af9d170a128a7c1f49646da1f4881f9b8234cf0ea7a0b3c836ccaa1eef6851" },
      heebo: { tgz: "76cdcd265afda95d798402a3e46b3c6669fd0356affdef4885bc6f6be1f0c549" },
      rubik: { tgz: "3f34e5588fcd07e01f1a5d667e5df1a6b287aeefba5b6e46f892131009a0db6a" },
      assistant: { tgz: "0fc35ba4e9728cb6b5832d02e20b9849d86430e4256b7cdba2ead88f67e4db1b" },
    },
    evidence: "Each npm tarball's package.json says \"license\": \"OFL-1.1\" and its LICENSE says \"This Font Software is licensed under the SIL Open Font License, Version 1.1.\" The fonts are only used to render the images; no font file is committed (OFL does not cover documents or images made with a font).",
  },
  moby: {
    name: "Moby-Dick, by Herman Melville (1851) — @stdlib/datasets-moby-dick",
    npm: "@stdlib/datasets-moby-dick",
    version: "0.2.3",
    tgz: "e85647c547a2e91ea24213bec496137132a9b4228b7fe881f4b0786ebedeafa1",
    evidence: "The package's README, section \"License\": \"The data files (databases) are licensed under an Open Data Commons Public Domain Dedication & License 1.0 and their contents are licensed under Creative Commons Zero v1.0 Universal.\" The novel (1851) is in the public domain.",
    cite: "Herman Melville, Moby-Dick; or, The Whale (1851); text from @stdlib/datasets-moby-dick 0.2.3 (The Stdlib Authors)",
  },
  sotu: {
    name: "State of the Union addresses — @stdlib/datasets-sotu",
    npm: "@stdlib/datasets-sotu",
    version: "0.2.3",
    tgz: "ab03f909e80b99afe2aa74474f7ca53e976982efa9f8c77f2bf3c34f179c85c9",
    evidence: "The package's README, section \"License\": \"The data files (databases) are licensed under an Open Data Commons Public Domain Dedication & License 1.0 and their contents are licensed under a Creative Commons Zero v1.0 Universal. State of the Union addresses are works of the United States Government and thus have no copyright protection under United States copyright law.\"",
    cite: "State of the Union addresses of the Presidents of the United States (works of the U.S. Government); text from @stdlib/datasets-sotu 0.2.3 (The Stdlib Authors)",
  },
  words: {
    name: "an-array-of-english-words (a filter only; no word of it is stored)",
    npm: "an-array-of-english-words",
    version: "2.0.0",
    tgz: "24a6f44cd209c8127ad0afacfff935e2af0831e4b0ed5fa62cd0e2c3774e2f2a",
    evidence: "package.json \"license\": \"MIT\"; license: \"(The MIT License) Copyright (c) 2014 Zeke Sikelianos\". Used by the builder to reject a corruption that is an English word; nothing from it is committed.",
  },
  rose: {
    name: "Nightingale's rose — @stdlib/datasets-nightingales-rose",
    npm: "@stdlib/datasets-nightingales-rose",
    version: "0.3.1",
    tgz: "1b8236930d4ccca365fefe392cb5eb156de21f51ceae5f6ad26fb36d6e068f29",
    evidence: "The package's README, section \"License\": \"The data files (databases) are licensed under an Open Data Commons Public Domain Dedication & License 1.0 and their contents are licensed under a Creative Commons Zero v1.0 Universal.\" The figures are Florence Nightingale's (1858).",
    cite: "Florence Nightingale, Notes on Matters Affecting the Health, Efficiency, and Hospital Administration of the British Army (1858); data from @stdlib/datasets-nightingales-rose 0.3.1 (The Stdlib Authors)",
  },
  wikipedia: {
    name: "Hebrew Wikipedia spelling corrections",
    api: "https://he.wikipedia.org/w/api.php",
    evidence: "Not reachable from the agent container. The workflow reads the wiki's own licence (siteinfo rightsinfo) and refuses unless it is CC BY-SA 4.0.",
  },
};

/** Hugging Face datasets: built by .github/workflows/golden-sets.yml (scripts/golden/hf_build.py). */
export const HF = {
  fleurs: { id: "google/fleurs", config: "he_il", split: "test", license: "cc-by-4.0", gated: false },
  "common-voice": { id: "mozilla-foundation/common_voice_17_0", config: "he", split: "test", license: "cc0-1.0", gated: true },
  flores: { id: "openlanguagedata/flores_plus", split: "devtest", license: "cc-by-sa-4.0", gated: true },
  belebele: { id: "facebook/belebele", license: "cc-by-sa-4.0", gated: false },
  deepset: { id: "deepset/prompt-injections", split: "test", license: "apache-2.0", gated: false },
  gandalf: { id: "Lakera/gandalf_ignore_instructions", split: "test", license: "mit", gated: false },
};

const unreachable = (hf) => `Hugging Face (${hf.id}) is not reachable from the agent container: not checked by hand. The workflow reads the dataset card and refuses unless its \`license:\` is \`${hf.license}\`.`;

/**
 * The sets. Part fields: id, items = dev + test, status (lib PART_STATUS),
 * license (SPDX or LicenseRef-*), workflow (job), token (needs HF_TOKEN),
 * owner (plan ref), review ("pending" until the owner checks it), about.
 *
 * dev is committed (about a quarter, chosen by a public seed); test is never
 * committed: CI rebuilds it from the same pool with the secret GOLDEN_SEED,
 * excluding the dev items. The owner's parts are all test and never in the
 * repo.
 */
export const SETS = [
  {
    id: "asr-he",
    title: "Hebrew speech recognition",
    capability: "6.1",
    metric: "WER (and CER) per part; normalise: NFC, no punctuation, no nikud",
    target: 80,
    license: "CC-BY-4.0 AND CC0-1.0",
    parts: [
      { id: "fleurs", items: 30, dev: 8, test: 22, status: "workflow-pending", workflow: "fleurs", license: "CC-BY-4.0", source: "FLEURS he_il, test split", url: "https://huggingface.co/datasets/google/fleurs", evidence: unreachable(HF.fleurs), about: "Utterances of the FLEURS he_il test split, transcoded to Ogg/Opus 32 kbps mono 16 kHz (lossy, to keep the repo small); the FLEURS id of each clip is kept." },
      { id: "common-voice", items: 30, dev: 8, test: 22, status: "workflow-pending", workflow: "common-voice", token: true, license: "CC0-1.0", source: "Common Voice he, test split", url: "https://huggingface.co/datasets/mozilla-foundation/common_voice_17_0", evidence: `${unreachable(HF["common-voice"])} Gated: the owner accepts the terms and adds HF_TOKEN (15.9, 15.11). Unverified risk: Mozilla may have moved Common Voice off Hugging Face; if the job cannot find it, this part needs a new source.`, about: "Validated clips of the Common Voice he test split, MP3 as published." },
      { id: "owner", items: 20, dev: 0, test: 20, status: "owner-pending", owner: "15.11", license: "CC0-1.0", source: "The owner's own recordings", about: "20 short recordings (5–20 s) of note-taking speech: dates, numbers, a few English words. WAV/FLAC/Opus, mono, ≥ 16 kHz, with the exact transcript. Never committed: CI reads them from the owner's encrypted bundle.", spec: "<id>.<wav|flac|opus> + transcripts.tsv (id<TAB>transcript) in the bundle folder asr-he/owner/, with CONSENT.md at the bundle root (eval/golden/README.md)" },
    ],
    notes: ["ivrit.ai (named for the download script in plan 7.1.5) is not wired yet: its datasets are on Hugging Face, which the agent container cannot reach, so their ids and licence terms are unchecked. It would be a local-only extra outside the 80, like FLORES+."],
  },
  {
    id: "mt-he-en",
    title: "Hebrew → English translation",
    capability: "6.4",
    metric: "chrF (sacreBLEU chrF2) per part; the owner's MQM-lite rating of 50 outputs (15.11)",
    target: 250,
    license: "CC-BY-SA-4.0 AND LicenseRef-CC-BY-2.0-FR",
    parts: [
      { id: "ntrex", items: 100, dev: 25, test: 75, status: "built", license: "CC-BY-SA-4.0", src: "ntrex", about: "Pool: the NTREX-128 lines with 4–45 Hebrew words in the half of NTREX that mt-he-en owns (typos-he gets the other half). Direction he→en: the Hebrew is NTREX's human translation of the English WMT19 source, so the Hebrew side is translationese and the reference is the English original." },
      { id: "tatoeba", items: 50, dev: 12, test: 38, status: "workflow-pending", workflow: "tatoeba", license: "LicenseRef-CC-BY-2.0-FR", src: "tatoeba", about: "Hebrew sentences of ≥ 4 words with every linked English translation as references (Tatoeba heb-eng links)." },
      { id: "flores", items: 100, dev: 25, test: 75, status: "local-only", workflow: "flores", token: true, license: "CC-BY-SA-4.0", source: "FLORES+ devtest heb_Hebr ↔ eng_Latn", url: "https://huggingface.co/datasets/openlanguagedata/flores_plus", evidence: `${unreachable(HF.flores)} Gated (terms: do not re-host): never committed. The workflow freezes only ids and sha256 of the dev items (selection/flores.json).`, about: "devtest sentences; `hf_build.py fetch-local` downloads the dev items locally, CI the test items." },
    ],
  },
  {
    id: "nikud",
    title: "Hebrew diacritisation (nikud)",
    capability: "6.3",
    metric: "DER / WER, with and without dagesh and shva; consonant skeleton must be identical",
    target: 100,
    license: "LicenseRef-PublicDomain",
    parts: [
      { id: "benyehuda", items: 60, dev: 15, test: 45, status: "built", review: "pending", owner: "15.11", license: "LicenseRef-PublicDomain", src: "benyehuda", about: "Fully pointed sentences or verse lines (5–25 words; every letter but א ה ו י and final ם ן ץ ף carries a mark) from Ben-Yehuda works that are not translations, mostly poetry. Older literary Hebrew: reported separately from the modern set (6.3). Review pending: the owner proofreads the nikud of dev and test (15.11)." },
      { id: "nakdimon", items: 40, dev: 10, test: 30, status: "local-only", license: "NOASSERTION", src: "nakdimon", about: "Modern sentences from Nakdimon's tests/new set (the acceptance set of 6.3), one per file across its 11 genres. Text never committed: selection/nakdimon.json freezes ids, paths, lines and sha256 of the dev items; CI picks the test items." },
    ],
  },
  {
    id: "ocr-he",
    title: "Hebrew OCR",
    capability: "7.5",
    metric: "CER per condition: clean printed, degraded, nikud lines (report only); word order per line on mixed-script column pages (W1.18)",
    target: 170,
    license: "CC0-1.0",
    parts: [
      { id: "lines", items: 120, dev: 30, test: 90, status: "built", license: "CC0-1.0", src: "fonts", about: "Short line images (1–3 lines) rendered in Chromium from 6 OFL fonts (20 per font: dev 5, test 15), clean, degraded (blur, rotation, noise, low contrast) or nikud lines. Text: public-domain prose and pointed verse from Project Ben-Yehuda and document-style lines generated for this set (dates, amounts, phone-like numbers, English words)." },
      { id: "pages", items: 15, dev: 4, test: 11, status: "built", license: "CC0-1.0", src: "fonts", about: "Synthetic pages (heading, paragraphs, a list); the browser's own line breaks are recorded as the ground truth; about half degraded." },
      { id: "mixed", items: 20, dev: 5, test: 15, status: "built", license: "CC0-1.0", src: "fonts", about: "Plan W1.18: synthetic pages in two or three columns under a heading, whose paragraphs mix Latin words, prefixed Latin words (ב-Zoom), e-mail addresses and numbers into Hebrew prose; the browser's lines are recorded in reading order (right column first). Scored for CER and for word order per line." },
      { id: "owner", items: 15, dev: 0, test: 15, status: "owner-pending", owner: "15.11", license: "CC0-1.0", source: "The owner's photographed pages", about: "15 phone photos of printed Hebrew pages the owner may share (own documents, public-domain books), with the exact text. Never committed.", spec: "<id>.jpg + <id>.txt (exact text) in the bundle folder ocr-he/owner/, with CONSENT.md at the bundle root (eval/golden/README.md)" },
    ],
  },
  {
    id: "typos-he",
    title: "Hebrew spelling errors",
    capability: "9.2",
    metric: "recall on non-word errors; false positives on the clean side",
    target: 200,
    license: "CC-BY-SA-4.0",
    parts: [
      { id: "synthetic", items: 150, dev: 38, test: 112, status: "built", license: "CC-BY-SA-4.0", src: "ntrex", about: "NTREX-128 Hebrew sentences (the half of NTREX that mt-he-en does not use) with 1–2 injected errors each: keyboard neighbours (SI-1452 layout), sound-alike letters (ט/ת, כ/ח, ק/כ, א/ע, ס/ש, ב/ו), final-letter forms, transposition, deletion, doubling, a split or joined word. Only words seen ≥ 3 times in NTREX are corrupted, and a corruption that is itself an NTREX word is rejected, so `nonword` is a heuristic (no dictionary was used, to avoid biasing 9.2). The clean side measures false positives; NTREX's own rare typos are a known noise source. The generator is public; the test sentences and errors come from GOLDEN_SEED." },
      { id: "wikipedia", items: 50, dev: 12, test: 38, status: "workflow-pending", workflow: "wikipedia-typos", review: "pending", owner: "15.11", license: "CC-BY-SA-4.0", src: "wikipedia", about: "Single-word spelling fixes mined from Hebrew Wikipedia edits whose summary names a spelling fix, with the old and new revision ids for attribution. The owner confirms each pair (15.11)." },
    ],
  },
  {
    id: "retrieval",
    title: "Hebrew retrieval",
    capability: "5.2, 7.6",
    metric: "nDCG@10 per part (BM25: heq + owner; hybrid: belebele)",
    target: 130,
    license: "CC-BY-SA-4.0 AND CC-BY-4.0 AND CC0-1.0",
    parts: [
      { id: "heq", items: 50, dev: 12, test: 38, status: "built", license: "CC-BY-4.0 AND CC-BY-SA-4.0", src: "heq", about: "Answerable HeQ test questions as queries (one per paragraph, Wikipedia and Geektime alike) over a corpus of all 238 HeQ test paragraphs, which the dev file carries; one relevant paragraph each, the other paragraphs of the same article listed but unjudged. HeQ is CC BY 4.0; its Wikipedia paragraphs are CC BY-SA at their origin, so this folder is CC BY-SA 4.0 for them (each document records its origin)." },
      { id: "owner", items: 30, dev: 0, test: 30, status: "owner-pending", owner: "15.11", license: "CC0-1.0", source: "The owner's own queries", about: "30 real queries over the owner's notes, each tagged with the notes that answer it. Never committed.", spec: "queries.json: [{id, query, relevant: [note paths]}] + notes/ in the bundle folder retrieval/owner/, with CONSENT.md at the bundle root (eval/golden/README.md)" },
      { id: "belebele", items: 50, dev: 12, test: 38, status: "local-only", workflow: "belebele", license: "CC-BY-SA-4.0", source: "Belebele heb_Hebr + eng_Latn", url: "https://huggingface.co/datasets/facebook/belebele", evidence: `${unreachable(HF.belebele)} Its passages are FLORES text, so it stays local-only (plan 7.1.5); the workflow freezes ids and sha256 of the dev items.`, about: "Cross-lingual pairs: an English question, the Hebrew passage is the relevant document (measured in 7.6, hybrid search)." },
    ],
  },
  {
    id: "ner-pii",
    title: "Personal data and names (PII)",
    capability: "2.6",
    metric: "recall / precision per type; patterns ≥ 98%, names ≥ 85% recall",
    target: 250,
    license: "CC-BY-SA-4.0 AND MIT",
    parts: [
      { id: "iahltwiki", items: 100, dev: 25, test: 75, status: "built", license: "CC-BY-SA-4.0", src: "iahltwiki", about: "Sentences of the UD_Hebrew-IAHLTwiki test split with their nested IAHLT entities (PER, GPE, LOC, FAC, ORG, TIMEX, …) as character spans; 80% have a PER entity, 20% none." },
      { id: "synthetic", items: 150, dev: 38, test: 112, status: "built", license: "MIT", src: "faker", about: "Hebrew sentences from templates written for this set, filled with Faker he names, cities and streets and generated numbers: two thirds with PII (names, phones, emails, ת״ז with a valid check digit, Luhn-valid card numbers, Israeli IBANs, addresses, birth dates, licence plates), one third hard negatives (ת״ז with a wrong check digit, order and tracking numbers, historical dates, Luhn-invalid numbers). Every number is generated; none belongs to anyone. The templates are public; GOLDEN_SEED picks the test templates and values." },
    ],
  },
  {
    id: "caption",
    title: "Image descriptions",
    capability: "6.6",
    metric: "owner rating 1–5 (≥ 80% rated ≥ 4); chrF against the references as a secondary signal",
    target: 50,
    license: "CC-BY-4.0 AND CC-BY-2.0 AND CC0-1.0",
    parts: [
      { id: "xm3600", items: 30, dev: 8, test: 22, status: "workflow-pending", workflow: "xm3600-images", license: "CC-BY-4.0 AND CC-BY-2.0", src: "xm3600", about: "Crossmodal-3600 images with their Hebrew (and English) reference captions; the pool is every image with Hebrew captions and a CC BY 2.0 licence, half of each split photographed in Israel (locale he). The dev captions and attribution are committed now; the images (Open Images on S3) come from the workflow, resized to 640 px." },
      { id: "owner", items: 20, dev: 0, test: 20, status: "owner-pending", owner: "15.11", license: "CC0-1.0", source: "The owner's descriptions", about: "20 CC0 images (Wikimedia Commons or the owner's photos) with the owner's Hebrew description of each. Never committed.", spec: "<id>.jpg + descriptions.tsv (id<TAB>description<TAB>source URL) in the bundle folder caption/owner/, with CONSENT.md at the bundle root (eval/golden/README.md)" },
    ],
  },
  {
    id: "injection",
    title: "Prompt injection",
    capability: "2.7",
    metric: "unapproved writes = 0; detection recall / false positives on the benign items",
    target: 130,
    license: "Apache-2.0 AND MIT AND CC0-1.0",
    parts: [
      { id: "deepset", items: 40, dev: 10, test: 30, status: "workflow-pending", workflow: "deepset", license: "Apache-2.0", source: "deepset/prompt-injections, test split", url: "https://huggingface.co/datasets/deepset/prompt-injections", evidence: unreachable(HF.deepset), about: "Three quarters injections, one quarter benign prompts (label kept)." },
      { id: "gandalf", items: 30, dev: 8, test: 22, status: "workflow-pending", workflow: "gandalf", license: "MIT", source: "Lakera/gandalf_ignore_instructions, test split", url: "https://huggingface.co/datasets/Lakera/gandalf_ignore_instructions", evidence: unreachable(HF.gandalf), about: "Real \"ignore your instructions\" attempts from the Gandalf game." },
      { id: "bipia", items: 30, dev: 8, test: 22, status: "built", license: "MIT", src: "bipia", about: "Indirect injections: attacks from BIPIA's 15 text-attack categories (test file), each hidden at the start, middle or end of a different EmailQA email, with the email's real question as the user's task." },
      { id: "hebrew", items: 30, dev: 0, test: 30, status: "owner-pending", owner: "15.11", license: "CC0-1.0", source: "The owner's Hebrew attacks", about: "30 Hebrew injections inside Markdown notes, 6 per vector: HTML comment, image alt text, frontmatter, zero-width characters, bidi override (U+202E). Never committed.", spec: "hebrew.json: [{id, vector, carrier, user_task, injected}] in the bundle folder injection/hebrew/, with CONSENT.md at the bundle root (eval/golden/README.md)" },
    ],
  },
  {
    id: "langid",
    title: "Language identification",
    capability: "6.5",
    metric: "accuracy (≥ 95% on the Tatoeba part)",
    target: 240,
    license: "CC0-1.0",
    parts: [
      { id: "tatoeba", items: 200, dev: 48, test: 152, status: "workflow-pending", workflow: "tatoeba", license: "CC0-1.0", src: "tatoeba", about: "CC0 sentences in Lumen's 8 UI languages — he, en, ar, ru, fr, de, ja, zh (Tatoeba heb, eng, ara, rus, fra, deu, jpn, cmn) — from sentences_CC0 only: 6 per language in dev, 19 in test." },
      { id: "hard", items: 40, dev: 10, test: 30, status: "built", license: "CC0-1.0", source: "Written for this set", about: "Hard cases from a pool of about 90 written for this set: very short strings, mixed Hebrew/English, Yiddish and Ladino in Hebrew script, Arabic vs Persian vs Urdu, Russian vs Ukrainian, Japanese kanji-only vs Chinese, transliteration, nikud, code, numbers and emoji only (expected und). The pool is public; GOLDEN_SEED picks the test cases." },
    ],
  },
];

/**
 * The small sets of plan 7.10: one part each (the meetings slot waits for
 * the owner). Builders: scripts/golden/sets/small.mjs.
 */
SETS.push(
  {
    id: "spell-en",
    title: "English spelling errors",
    capability: "7.10",
    metric: "recall on the injected non-word errors (detection and correction); false positives on the clean sentences",
    target: 100,
    license: "CC0-1.0",
    notes: ["The English word list an-array-of-english-words 2.0.0 (MIT) is downloaded by the builder only to reject corruptions that are real words; no word of it is stored here."],
    parts: [{ id: "moby", items: 100, dev: 25, test: 75, status: "built", license: "CC0-1.0", src: "moby", about: "Sentences of 8–30 words from Moby-Dick (chapters 42–80) with 1–2 synthetic non-word errors each: adjacent transposition, deletion, doubling or a QWERTY-neighbour substitution, never in the first letter, only in words of ≥ 4 letters seen ≥ 3 times in those chapters, and never one that is itself a word of the chapters. Offsets of every edit are recorded." }],
  },
  {
    id: "image-search",
    title: "Image search by description",
    capability: "7.10",
    metric: "recall@1 and nDCG@10 of the relevant image among the split's images, per query language",
    target: 30,
    license: "CC-BY-4.0 AND CC-BY-2.0",
    parts: [{ id: "xm3600", items: 30, dev: 8, test: 22, status: "workflow-pending", workflow: "xm3600-images", license: "CC-BY-4.0 AND CC-BY-2.0", src: "xm3600", about: "Crossmodal-3600 images, each with its first English caption (and first Hebrew caption) as the search query; half of each split photographed in Israel. Drawn with this set's own seeds, so the images differ from the caption set's. The images (Open Images on S3) come from the workflow, like the caption set's." }],
  },
  {
    id: "clipper",
    title: "Web clipper: article extraction",
    capability: "7.10",
    metric: "title exact; paragraph recall and order; no noise (mustExclude) in the clip",
    target: 20,
    license: "CC0-1.0",
    parts: [{ id: "pages", items: 20, dev: 5, test: 15, status: "built", license: "CC0-1.0", src: "moby", about: "Static HTML pages saved as fixtures: the article is the opening of a Moby-Dick chapter (public domain, text CC0 via @stdlib) or a short Hebrew page written for this set (RTL), wrapped in one of 6 layouts written for this set (blog, news, docs, magazine, minimal, forum) with 4–8 noise blocks: navigation, cookie banner, ads and share bars between paragraphs, newsletter form, related links, comments, footer, hidden text, scripts. No page is a copy of a real site." }],
  },
  {
    id: "pdf-qa",
    title: "Questions over PDF documents",
    capability: "7.10",
    metric: "exact match / token F1 of the answer against answer + alt; citation of the right document",
    target: 30,
    license: "CC0-1.0",
    parts: [{ id: "docs", items: 30, dev: 8, test: 22, status: "built", license: "CC0-1.0", src: "sotu", about: "Three public-domain documents rendered to text PDFs by the builder (Courier, deterministic bytes): John Adams's 1800 and Herbert Hoover's 1932 State of the Union addresses and Moby-Dick chapter 1. 30 questions written for this set (10 per document); every answer is a verbatim span of its document (checked by the builder). The pool is the set: the test split is the 22 questions not in dev." }],
  },
  {
    id: "data-analysis",
    title: "Questions over a CSV",
    capability: "7.10",
    metric: "exact match (YYYY-MM, integers); |error| ≤ tolerance for decimals",
    target: 20,
    license: "CC0-1.0",
    parts: [{ id: "rose", items: 20, dev: 5, test: 15, status: "built", license: "CC0-1.0", src: "rose", about: "Florence Nightingale's monthly mortality of the British army in the East, April 1854 – March 1856 (24 rows: army size, deaths from disease, wounds, other causes), as a CSV. Questions from templates written for this set (sums per year, maxima, means, her annual rate per 1,000, counts, shares); the builder computes every answer from the CSV." }],
  },
  {
    id: "summarize",
    title: "Summarisation",
    capability: "7.10",
    metric: "key-word coverage and owner rating 1–5; ROUGE-L against the reference as a secondary signal",
    target: 20,
    license: "CC0-1.0",
    parts: [{ id: "sotu", items: 20, dev: 5, test: 15, status: "built", license: "CC0-1.0", src: "sotu", about: "The opening (about 200 words) of 20 State of the Union addresses from 1790 to 2005, with a reference summary of 1–2 sentences and 4 key words written for this set; the builder checks every key word occurs in its document. The pool is the set: the test split is the 15 not in dev." }],
  },
  {
    id: "formulas",
    title: "Database formulas",
    capability: "7.10",
    metric: "exact value and type",
    target: 30,
    license: "CC0-1.0",
    parts: [{ id: "row", items: 30, dev: 8, test: 22, status: "built", license: "CC0-1.0", source: "Written for this set", about: "Notion-style formulas over one database row: arithmetic and precedence, rounding, comparisons, booleans, text (concat, length, upper / lower, contains, empty), if, and dateBetween in days, months and years; English and Hebrew values. 30 templates, 3 slots each; the split's seed fills the rows. Expected values are computed with exact decimal arithmetic." }],
  },
  {
    id: "unlinked",
    title: "Unlinked mentions",
    capability: "7.10",
    metric: "precision / recall of mention spans (start, end, target)",
    target: 30,
    license: "CC0-1.0",
    parts: [{ id: "notes", items: 30, dev: 8, test: 22, status: "built", license: "CC0-1.0", source: "Written for this set", about: "Short notes that mention other notes' titles (English and Hebrew) without a link — plain, lower case, Hebrew with prefix letters (ו ה ב ל מ ש כ, וב, של), at the start of a line — next to cases that are not unlinked mentions: [[links]], aliased links, code spans, URLs, Markdown link text, a title inside a longer word, the note's own title." }],
  },
  {
    id: "bidi",
    title: "Line direction (bidi)",
    capability: "9.7",
    metric: "accuracy of the line's direction (rtl / ltr / neutral)",
    target: 30,
    license: "CC0-1.0",
    parts: [{ id: "lines", items: 30, dev: 8, test: 22, status: "built", license: "CC0-1.0", source: "Written for this set", about: "Markdown lines mixing Hebrew, English, Arabic and neutral runs (times, dates, phone numbers, emoji, punctuation), Latin tokens inside Hebrew, RLM, links and code, behind heading, list, task and quote markers. The expected direction is the first strong character (UAX #9 P2–P3) after the Markdown markers, with link URLs and code spans ignored." }],
  },
  {
    id: "hebrew-dates",
    title: "Hebrew calendar dates",
    capability: "4.12",
    metric: "exact day, month and year in both directions",
    target: 20,
    license: "CC0-1.0",
    notes: ["Cross-check when the set was built (2026-10-18): for all 120 pool dates, @hebcal/core 6.14.4 (HDate, gematriya) gave the same day, month, year and Hebrew numerals as the builder's ICU conversion and its own numerals — 0 mismatches. @hebcal/core is GPL-2.0 and is not a dependency; it was run once outside the repo."],
    parts: [{ id: "dates", items: 20, dev: 5, test: 15, status: "built", license: "CC0-1.0", source: "Written for this set", about: "Gregorian ↔ Hebrew conversions over 1900–2099, with edge dates (Rosh Hashana, Adar I / Adar II in leap years, 30 Heshvan / Kislev). Expected values from the ICU Hebrew calendar (Intl), cross-checked against @hebcal/core when the set was built; the Hebrew text uses Hebrew numerals (ט״ו / ט״ז, year without the thousands)." }],
  },
  {
    id: "citations",
    title: "Citations",
    capability: "7.10",
    metric: "exact APA 7 reference and in-text citation; BibTeX fields",
    target: 20,
    license: "CC0-1.0",
    parts: [{ id: "records", items: 20, dev: 5, test: 15, status: "built", license: "CC0-1.0", source: "Written for this set", about: "Records of public-domain books and classic papers (bibliographic facts), with the expected APA 7 reference, APA in-text citation and BibTeX entry formatted by one written-down rule set in the builder (sentence-case titles are given in the record). The pool has 23 records; the test split is 15 of the 18 not in dev." }],
  },
  {
    id: "meetings",
    title: "Meeting recordings",
    capability: "7.10",
    metric: "WER of the transcript; owner rating of the summary and action items",
    target: 5,
    license: "CC0-1.0",
    parts: [{ id: "owner", items: 5, dev: 0, test: 5, status: "owner-pending", owner: "15.11", license: "CC0-1.0", source: "The owner's own meeting recordings", about: "5 recordings (5–30 min) of real meetings the owner may share, with the exact transcript, a reference summary and the action items. Never committed: CI reads them from the owner's encrypted bundle.", spec: "<id>.<wav|flac|opus|m4a> + <id>.transcript.txt + <id>.summary.md (summary and action items) in the bundle folder meetings/owner/, with CONSENT.md at the bundle root (eval/golden/README.md)" }],
  },
);

export const setById = (id) => SETS.find((s) => s.id === id);
