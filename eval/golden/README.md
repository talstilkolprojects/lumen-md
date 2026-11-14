# Golden sets

Held-out, licensed eval sets for Lumen's local AI (plan task 7.1, appendix 20). Each set measures one capability against a threshold that the capability's own task fixed before it was implemented. A separate agent builds and freezes these sets; whoever implements a feature never writes its set.

**The repo holds only the dev split.** About a quarter of each part, inputs and answers, is in `<set>/dev/`, and implementers may tune on it. **The test split is never committed.** CI rebuilds it from the same public pools with the secret seed `GOLDEN_SEED`, runs the evals there and publishes scores only. The repo keeps a manifest of the test split instead: its item count, the sha256 of each part and of the whole split, and its own canary. The owner's material (plan 15.11) never enters the repo at all.

## The ten sets

| Set | For | Target | Dev in the repo now | Test (CI only) | Parts: source → status | Licence |
|---|---|---|---|---|---|---|
| asr-he | 6.1 | 80 | 0 of 16 | 64 | FLEURS 30 → workflow · Common Voice 30 → workflow + HF_TOKEN · owner 20 → owner | CC BY 4.0; CC0 |
| mt-he-en | 6.4 | 250 | 25 of 62 | 188 | NTREX-128 100 → **built** · Tatoeba 50 → workflow · FLORES+ 100 → local-only (selection: workflow + HF_TOKEN) | CC BY-SA 4.0; CC BY 2.0 FR |
| nikud | 6.3 | 100 | 15 of 15 + 10 ids | 75 | Ben-Yehuda 60 → **built**, owner review pending · Nakdimon 40 → local-only (**selection frozen**) | public domain; Nakdimon local-only |
| ocr-he | 7.5 | 150 | 34 of 34 | 116 | rendered lines 120 → **built** · rendered pages 15 → **built** · owner photos 15 → owner | CC0 (OFL fonts used, not shipped) |
| typos-he | 9.2 | 200 | 38 of 50 | 150 | synthetic 150 → **built** · Wikipedia fixes 50 → workflow + owner review | CC BY-SA 4.0 |
| retrieval | 5.2, 7.6 | 130 | 12 of 24 | 106 | HeQ 50 → **built** · owner queries 30 → owner · Belebele 50 → local-only (selection: workflow) | CC BY 4.0 / BY-SA 4.0; CC0 |
| ner-pii | 2.6 | 250 | 63 of 63 | 187 | IAHLTwiki 100 → **built** · synthetic 150 → **built** | CC BY-SA 4.0; MIT |
| caption | 6.6 | 50 | 0 of 8 (captions in, images pending) | 42 | Crossmodal-3600 30 → workflow (images) · owner 20 → owner | CC BY 4.0 + CC BY 2.0; CC0 |
| injection | 2.7 | 130 | 8 of 26 | 104 | deepset 40 → workflow · Gandalf 30 → workflow · BIPIA 30 → **built** · Hebrew 30 → owner | Apache-2.0; MIT; CC0 |
| langid | 6.5 | 240 | 10 of 58 | 182 | Tatoeba CC0 200 → workflow · hard cases 40 → **built** | CC0 |

`node scripts/golden.mjs status` prints the live version of this table. Each `<set>/SOURCES.md` names every part's source, its pinned commit or version, the sha256 of each upstream file, the licence with the evidence it was checked against, and what the part is still waiting for.

## Layout

```
eval/golden/<set>/
  manifest.json        set metadata, parts (dev / test counts, status), the sha256 of every committed
                       file, the test split's manifest (canary, item count, sha256 per part and in all),
                       version and changelog
  SOURCES.md           where each part comes from, its licence and the evidence; the dev canary
  LICENSE              the licence texts (SPDX license-list-data v3.28.0) and notices of every part
  dev/<part>.json      the dev items: { canary, set, part, split: "dev", license, source, fields, items: […] }
  dev/<part>/…         the dev items' files (images, audio)
  selection/<part>.json   local-only parts: ids and sha256 of the dev items, no text
  local/               git-ignored: local-only dev items fetched by `hf_build.py fetch-local`
```

The builders are in `scripts/golden/`. `build.mjs` builds the GitHub, npm and generated parts. `hf_build.py` builds the Hugging Face, Tatoeba and Wikipedia parts, and only the workflow runs it. `owner.mjs` reads the owner's bundle in CI, `run-evals.mjs` scores the test split, and `defs.mjs` describes all ten sets. The rules shared by all of them, and the loader, are in `scripts/lib/golden.mjs`. The CLI is `scripts/golden.mjs`, also available as `npm run golden -- <command>`.

## Dev and test: the secret seed

Every part has a public **pool**, such as the 1,997 NTREX lines in mt-he-en's half, the HeQ test paragraphs, or the slots of a generator. Two seeds split the pool, and the same seed always gives the same items, in Node and in Python alike:

- **dev**: the first `dev` items by sha256 of `lumen-golden-v1:<set>:<part>:dev` and the item key. This seed is public, so anyone can rebuild the dev split.
- **test**: the first `test` items of the rest of the pool, by sha256 of `$GOLDEN_SEED:<set>:<part>:test` and the item key. It never overlaps dev.

Generated parts (typos, PII, OCR, langid hard cases) work the same way. The generator is public, and the split's seed picks the sentences, the templates, the values, the injected errors, the fonts and the degradations. **What the secret hides is which items and values the test split uses, not the pool or the generator.** Someone who tunes on a whole public pool, such as all of NTREX or every BIPIA attack, can still overfit. That risk is inherent to public sources, and it is why only the dev share is in the worktree.

`.github/workflows/golden-sets.yml` with `task=test`, which also runs nightly, does the following:

1. It builds the test split into `$RUNNER_TEMP/golden-test`, never into the checkout. The builders print counts and sha256 only, never an item.
2. It adds the owner's parts from the encrypted bundle (see "The owner's part" below).
3. It compares every part with the sha256 recorded in the manifest. A mismatch means the source drifted or a builder changed, and the part has to be re-recorded with a reason.
4. It runs `scripts/golden/run-evals.mjs`, which calls each set's harness `scripts/golden/evals/<set>.mjs`. The feature task writes that harness: it exports `score({ items, manifest }) → { metric: number }`. Only the numbers go to `scores.json` and the job summary.
5. It keeps the split for one day as an artifact encrypted with `GOLDEN_SEED`. Anyone who can read the repo can download artifacts, so the split is never uploaded unencrypted.

The first run with a seed records the hashes: run the workflow with `task=test` and `record=true`. A separate job, which never sees the split, writes the hashes to a branch `golden/test-sha-<run id>`. Open a PR from it.

## Freezing

`manifest.json` lists the sha256 of every committed file in the set. `node scripts/golden.mjs verify` and the test (`src/__tests__/golden-sets.test.ts`) check that list, the parts and the test manifest, and they fail on any difference. A frozen set changes only through a new version that states its reason (appendix 20.2 rule 2):

```
node scripts/golden.mjs freeze <set> --reason "why"      # or: node scripts/golden/build.mjs <set> --split dev --reason "why"
```

That command bumps the version and appends `{ version, date, reason }` to the changelog. The set is `partial` while a dev part, a test hash or an owner review is still missing. It becomes `locked` once all of them are in (7.1.6). After that, changes are still possible, but each one is a new version with a reason.

## Canaries

Each set has two canaries of the form `LUMEN GOLDEN SET - DO NOT TRAIN ON THIS DATA. canary GUID <uuid>`:

- the **dev canary**, which is in every dev JSON file and in SOURCES.md (`verify` fails on a text file without it);
- the **test canary**, which is in every test-split file (as a tEXt chunk in the PNGs) and nowhere in the repo except `manifest.json`.

They serve three purposes:

- **Contamination of a model.** Search a training corpus for the GUIDs (`node scripts/golden.mjs canaries` prints them all). Alternatively, give a model the prefix and the first characters of a GUID: if it completes the rest, it has seen the data.
- **Test data in the repo.** `verify` and the test scan every file git tracks or would track (`git ls-files -co --exclude-standard`) for any test canary. A test file that reached the worktree fails CI.
- **Provenance.** A file found elsewhere can be traced back to its set and split.

## Running a set

```js
import { loadSet } from "./scripts/lib/golden.mjs";
const { items, manifest } = loadSet("eval/golden", "mt-he-en");                            // dev (committed)
const local = loadSet("eval/golden", "nikud", { local: true });                            // + local-only dev items, hash-checked
const test = loadSet("eval/golden", "mt-he-en", { split: "test", testDir: process.env.GOLDEN_TEST }); // CI only
```

`loadSet` refuses a set that does not validate, or a test part whose sha256 differs from the recorded one. Asset paths come back absolute. `npm run golden -- show <set> --limit 3` prints dev items. Each data file's `fields` describes its items, and `manifest.metric` names the metric.

Local-only parts (FLORES+, Belebele, Nakdimon) are never in the repo. To evaluate on their dev items locally, run:

```
pip install -r scripts/golden/requirements.txt
HF_TOKEN=… python -I scripts/golden/hf_build.py fetch-local      # writes eval/golden/<set>/local/, checks every sha256
```

## Building

- **GitHub, npm and generated parts** (rendering needs Playwright's Chromium; elsewhere, set `GOLDEN_CHROMIUM` to a Chromium binary):
  `node scripts/golden/build.mjs --split dev --cache <dir>`
  With unchanged sources, a rebuild of a frozen set reproduces it exactly and reports `unchanged`.
- **Hugging Face, Tatoeba, Wikipedia and Open Images parts**: these run in GitHub Actions, because the agent container cannot reach those hosts. Go to Actions → **Golden sets** → Run workflow and set `task=dev`, `parts=all` (or some of the jobs). From the CLI:
  `gh workflow run golden-sets.yml -f task=dev -f parts=all`
  The run checks each licence at the source: the dataset card's `license:` on Hugging Face, and the siteinfo on Wikipedia. It refuses a part on any mismatch, builds the dev parts, runs `verify` and the licence gate, and pushes a branch `golden/dev-<run id>`, from which you open a PR. FLORES+ and Common Voice are skipped until `HF_TOKEN` exists.
- **Test split** (needs `GOLDEN_SEED`):
  `gh workflow run golden-sets.yml -f task=test -f record=true`

### Secrets the owner adds (plan 15.9)

Add these under Settings → Secrets and variables → Actions. Preferably put them in an environment named `golden` that is restricted to `main`, with the owner as required reviewer, so branch workflows cannot read them.

| Secret | What | Needed for |
|---|---|---|
| `GOLDEN_SEED` | A long random string, for example from `openssl rand -hex 32`. Never share it, and never print it. | any test split |
| `HF_TOKEN` | A Hugging Face read token, created after accepting the terms of FLORES+ and Common Voice (15.11). | FLORES+, Common Voice |
| `GOLDEN_OWNER_KEY` | The passphrase of the owner's encrypted bundle. | the owner's parts |

## The owner's part (plan 15.11)

The owner's recordings, photos, queries, descriptions and attacks never enter the repo. Pack them as one folder:

```
golden-owner/
  CONSENT.md                       "I dedicate everything in this bundle to the public domain (CC0 1.0)" + name, date
  asr-he/owner/<id>.wav|flac|opus  20 recordings, mono ≥ 16 kHz, 5–20 s
  asr-he/owner/transcripts.tsv     <id><TAB><exact transcript>
  ocr-he/owner/<id>.jpg + <id>.txt 15 phone photos of printed Hebrew pages + their exact text
  retrieval/owner/queries.json     [{ "id", "query", "relevant": ["<path under notes/>.md", …] }]  (30)
  retrieval/owner/notes/…          the notes the queries point to (or a shareable copy)
  caption/owner/<id>.jpg           20 CC0 images
  caption/owner/descriptions.tsv   <id><TAB><Hebrew description><TAB><source URL or "own photo">
  injection/hebrew/hebrew.json     [{ "id", "vector", "carrier", "user_task", "injected" }]  (30; 6 per vector:
                                   html-comment, image-alt, frontmatter, zero-width, bidi-override)
```

Then encrypt the folder and attach it to a **draft** release, which is never published. Only people with write access can see a draft:

```
tar -czf golden-owner.tar.gz golden-owner
gpg --symmetric --cipher-algo AES256 --output golden-owner.tar.gz.gpg golden-owner.tar.gz   # the passphrase becomes GOLDEN_OWNER_KEY
gh release create golden-owner --draft --title golden-owner --notes "encrypted golden-set bundle (15.11)" golden-owner.tar.gz.gpg
rm golden-owner.tar.gz
```

The next `task=test` run decrypts the bundle in the runner. `scripts/golden/owner.mjs` then checks every part's count and format and writes the parts into the test split, and `record=true` records their hashes. To change the bundle, upload a new asset and record again with a reason. The owner's other 15.11 tasks need nothing from this folder:

- proofreading the Ben-Yehuda nikud and the Wikipedia pairs: run the test build locally with the seed (`GOLDEN_SEED=… node scripts/golden/build.mjs nikud --split test --out ~/golden-test`), then send the fixes;
- accepting the FLORES+ and Common Voice terms;
- rating translations and captions: done on scores runs.

## Known limits

- **Hugging Face licences.** These were not checked by hand, because the container cannot reach Hugging Face. The workflow checks every card at run time and refuses a mismatch.
- **Common Voice.** Mozilla may have moved Common Voice off Hugging Face. If so, the `common-voice` job reports it and that part needs a new source.
- **Tatoeba drift.** The Tatoeba exports change every week. The dev build freezes the pool as sentence ids, and the test build reads those ids from the current export, so a sentence edited upstream shows up as a hash mismatch. Wikipedia pairs are frozen as revision ids, which never change.
- **OCR rendering.** The dev images were rendered with Chromium 141 (the container's). CI renders the test split with Playwright's own Chromium, and its hashes are recorded from CI.
- **Nikud set.** The Ben-Yehuda part is mostly medieval and liturgical poetry: that is where full pointing exists in the dump. It is reported separately from the modern Nakdimon part (6.3).
