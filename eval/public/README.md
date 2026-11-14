# Public Hebrew benchmarks (plan W11.H5)

Lumen's Hebrew numbers are measured on **public** sets, so anyone can check
them against ivrit.ai's, Dicta's or Unicode's own tables. This folder holds
only **manifests**: which set, at which revision, with which sha256, licence,
split, normaliser and metrics. The data is never committed or shipped.

| File | What it is |
|---|---|
| `<id>.json` | A manifest (schema: `src/eval/public/manifest.ts`). |
| `_self-built.json` | The few self-built sets that stay, because no public set exists for them (spelling, grammar, Markdown bidi lines, the owner's voice). |
| `_verdicts.json` | Generated from `eval/results` by `npm run eval:public -- verdicts`; the app's gates read it (a neural voice, handwriting recognition). Never edit it by hand. |
| `.data/` | Downloaded data (git-ignored). |

Results are `eval/results/<id>/<model>@<revision>.json`, one per model and
revision, each with the command that reproduces it.

```bash
npm run eval:public -- list                    # pinned or not, and what is owed
npm run eval:public -- fetch asr-fleurs-he --pin
npm run eval:public -- run asr-fleurs-he --engine engines/zipformer.mjs --model ivrit-ai/zipformer2-66m-streaming-he --rev ee769a2a13b887f91572eec349458bfb0fe79e7a
npm run eval:public -- run unicode-bidi        # Unicode's BidiCharacterTest / BidiTest
npm run eval:public -- check                   # the gate (also a ci:local step)
```

**The gate** (`npm run eval:public -- check`, ci:local step `public-eval`)
fails on an invalid manifest; on a result that is stale (another model
revision than models/registry.json pins, or another dataset revision than its
manifest); on a result without a reproduction command or made from a
synthetic fixture; and on any dataset file in the repo or in dist.

A run refuses an unpinned manifest: a number measured on a set that is not
pinned cannot be reproduced. Every manifest's `owed` list says what still
has to be done on a machine with network.

Known gap: the older `eval/golden/*/dev` folders still hold copies of some
public data (for example NTREX and XM3600 rows). They predate this harness
and are outside this gate; moving them to manifests is separate work.

---

## מדדים ציבוריים לעברית

המספרים של Lumen בעברית נמדדים על סטים **ציבוריים**, כך שכל אחד יכול להשוות
אותם לטבלאות של ivrit.ai, ‏Dicta או Unicode. בתיקייה הזו יש רק **מניפסטים**:
איזה סט, באיזו גרסה, עם איזה sha256, רישיון, פיצול, מנרמל ומדד. הנתונים
עצמם לא נכנסים לריפו ולא ל-dist אף פעם.

התוצאות נשמרות ב-`eval/results/<id>/<model>@<revision>.json`, אחת לכל מודל
וגרסה, ולכל אחת הפקודה שמשחזרת אותה. השער (`npm run eval:public -- check`)
נכשל על מניפסט לא תקין, על תוצאה ישנה (גרסת מודל או סט אחרת מזו הנעוצה),
על תוצאה בלי פקודת שחזור או מתוך נתוני בדיקה סינתטיים, ועל כל קובץ נתונים
בריפו או ב-dist. הרצה מסרבת לעבוד על מניפסט שלא נעוץ.
