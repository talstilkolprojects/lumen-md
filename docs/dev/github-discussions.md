# GitHub Discussions — setup (plan W4.34)

[עברית למטה](#הקמת-github-discussions)

Discussions is where readers ask questions, suggest ideas and show what they
built, in Hebrew or English, without opening an issue. As of 12.11.2026 the
repository has it **off** (`has_discussions: false`). The forms for three of
the categories are already in the repo, under `.github/DISCUSSION_TEMPLATE/`.

## Owner steps (Tal)

1. **Turn Discussions on.** Either open *Settings → General → Features* and tick
   **Discussions**, or run:

   ```sh
   gh api -X PATCH repos/talstilkol/lumen-md -F has_discussions=true
   ```

2. **Name the categories.** GitHub creates the default categories. Open
   *Discussions → Categories* (the pencil next to each category) and set the
   names and descriptions below. Then add **Polls** if it is missing.

   | Default slug | Name | Description | Format |
   |---|---|---|---|
   | `announcements` | Announcements · הודעות | Releases and news from the maintainers · גרסאות וחדשות מהצוות | Announcement |
   | `q-a` | Q&A · שאלות ותשובות | Ask the community for help · שאלו את הקהילה | Question / Answer |
   | `ideas` | Ideas · רעיונות | Ideas for Lumen: the problem first · רעיונות ל-Lumen: קודם הבעיה | Open-ended discussion |
   | `show-and-tell` | Show and tell · הראו מה בניתם | Vaults, templates, plugins, workflows · כספות, תבניות, תוספים | Open-ended discussion |
   | `general` | General · כללי | Everything else · כל השאר | Open-ended discussion |
   | `polls` | Polls · סקרים | Vote on what comes next · הצביעו על הבא בתור | Poll |

3. **Check the forms against the categories.** A form works only if its file
   name is its category's slug. Renaming a category can change the slug. Run:

   ```sh
   node scripts/discussions-check.mjs
   ```

   It reads the categories with `gh api graphql` and says which form file to
   rename if a slug changed. Commit the rename to `main`, because forms are
   read from the default branch.

4. **Pin a welcome post** in Announcements. It should link the docs, the
   [code of conduct](../../CODE_OF_CONDUCT.md), and the rule that bugs and
   security issues go elsewhere: bugs to Issues, security issues as
   [SECURITY.md](../../SECURITY.md) says.

5. **Point the docs at it.** Add a "Discussions" link to the docs site's social
   links (`social` in `docs/astro.config.mjs`) and to the feedback page. Do this
   only after step 1, so nothing links to a page that does not exist.

## What is in the repo

- `.github/DISCUSSION_TEMPLATE/q-a.yml`, `ideas.yml` and `show-and-tell.yml` are
  forms with Hebrew labels and English hints. GitHub does not support forms for
  polls, and announcements are written by the maintainers.
- `scripts/discussions-check.mjs` checks the forms. `--offline` checks only
  their structure; without it, it also checks the live categories.

---

# הקמת GitHub Discussions

ב-Discussions קוראים שואלים שאלות, מציעים רעיונות ומציגים מה בנו, בעברית או
באנגלית, בלי לפתוח issue. נכון ל-12.11.2026 האפשרות **כבויה** במאגר
(`has_discussions: false`). הטפסים של שלוש קטגוריות כבר נמצאים במאגר, תחת
`.github/DISCUSSION_TEMPLATE/`.

## הצעדים של הבעלים (טל)

1. **להפעיל את Discussions.** אפשר לסמן **Discussions** תחת
   *Settings ← General ← Features*, או להריץ:

   ```sh
   gh api -X PATCH repos/talstilkol/lumen-md -F has_discussions=true
   ```

2. **לתת שמות לקטגוריות.** GitHub יוצר את קטגוריות ברירת המחדל. פותחים את
   *Discussions ← Categories* (העיפרון ליד כל קטגוריה) וקובעים את השמות
   והתיאורים מהטבלה למעלה. אחר כך מוסיפים **Polls** אם הקטגוריה חסרה.
3. **לבדוק שהטפסים תואמים לקטגוריות.** טופס עובד רק אם שם הקובץ שלו הוא ה-slug
   של הקטגוריה, ושינוי שם של קטגוריה יכול לשנות את ה-slug. מריצים
   `node scripts/discussions-check.mjs`. הסקריפט קורא את הקטגוריות ואומר איזה
   קובץ טופס לשנות אם slug השתנה. את השינוי מבצעים ב-`main`, כי GitHub קורא את
   הטפסים מהענף הראשי.
4. **להצמיד הודעת פתיחה** בקטגוריית ההודעות. ההודעה צריכה לקשר לתיעוד ולקוד
   ההתנהגות, ולומר שבאגים הולכים ל-Issues ובעיות אבטחה מדווחים כמו שכתוב
   ב-SECURITY.md.
5. **לקשר מהתיעוד.** מוסיפים קישור ל-Discussions בקישורים החברתיים של אתר
   התיעוד ובדף המשוב. עושים את זה רק אחרי צעד 1, כדי שאף קישור לא יוביל לדף
   שלא קיים.
