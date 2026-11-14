# Launch plan — the Hebrew beta (plan W2.25)

> A plan and drafts. **Nothing is posted or sent from here.** Every post below
> is a draft for Tal to adapt and publish himself.

## Goals (the plan's acceptance)

- ≥ 50 active beta testers, meaning they opened Lumen on ≥ 3 days a week.
  This is **measured only by the voluntary weekly survey** (`launch/survey.md`);
  the app counts nobody.
- ≥ 30 feedback reports triaged (labels from plan 14.3).
- The comparison page passes a fact check: `npm run launch:check -- --strict`
  is green, meaning every claim is verified.

## Before (T-14 → T-1)

See `launch/checklist.md`. In short:
- the beta build and web deployment (plan 14.4);
- the Discussions categories and forms;
- the comparison fact-checked;
- screenshots;
- a reporting address in COMMUNITY.md.

## Where, in order

| When | Where | Who it reaches | Note |
|---|---|---|---|
| T0 | Personal network: friends, colleagues, students | the first 10–15 testers | personal messages, not a broadcast |
| T0 | Israeli university lists and course forums Tal has access to | students and researchers | ask the list owner first |
| T+2 | Israeli tech communities (Facebook / Telegram / Discord groups for developers and note-taking) | developers, power users | follow each group's self-promotion rules |
| T+3 | Hebrew writing and academic writing groups | writers | lead with the Hebrew problems it fixes |
| T+7 | Show HN | international developers | English, link to the source code; answer every comment for the first hours |
| T+10 | Product Hunt | early adopters | needs a maker account; prepare the gallery from the screenshot list |
| T+14 | A short write-up of what the beta taught us | everyone so far | in Discussions and on the blog, if there is one |

Pace it: the next channel only after the feedback from the last one is
triaged. Fifty engaged testers beat five hundred sign-ups.

## Drafts

### Hebrew (communities, lists)

> בניתי עורך פתקים שמתחיל מהעברית, ואני מחפש 50 אנשים שינסו אותו כמה
> פעמים בשבוע ויגידו לי מה לא עובד.
>
> ‏Lumen הוא עורך Markdown חינמי וקוד פתוח. הממשק בעברית, הכיוון נקבע לכל
> שורה (גם כשיש באמצע מונח באנגלית או מספר), החיפוש מוצא מילים עם תחיליות,
> והפתקים נשמרים אצלכם, לא בענן. עובד בדפדפן, גם בלי אינטרנט.
>
> זו בטא, עם פינות לא מלוטשות. אם אתם כותבים בעברית — סיכומים, מחקר, כתיבה
> או תיעוד — אשמח שתצטרפו: [קישור לדף הבטא]
>
> ובלי שיווק: יש גם דף השוואה כן מול Obsidian, ‏Notion ו-Google Docs, עם מה
> שעוד חסר אצלנו ומקור לכל טענה.

### Show HN (English)

> **Show HN: Lumen – a local-first Markdown editor built for Hebrew (RTL)**
>
> I write mostly in Hebrew, and most editors treat right-to-left as an
> afterthought: punctuation lands at the wrong end, an English word in a
> Hebrew sentence reorders the line, search misses words with a one-letter
> prefix. Lumen starts from there. It sets direction per line, folds niqqud
> and Hebrew prefixes in search, and mirrors the UI.
>
> It's local-first: notes are plain .md files in browser storage or a folder,
> it works offline as a PWA, and there's a desktop build (Tauri). MIT-licensed. There's
> an honest comparison page, including what it still lacks: no hosted sync,
> young co-editing, a small plugin ecosystem.
>
> Source: https://github.com/talstilkol/lumen-md. I'd love feedback,
> especially from anyone who writes in Arabic, Persian or Hebrew.

### Product Hunt

- **Tagline (60 chars max):** "A local-first Markdown editor built for Hebrew and RTL"
- **Description:** the one-paragraph text from `press-kit.md`.
- **First comment:** why it exists, what's missing, and how to join the beta.

## After

- Triage feedback every day of the first week, and weekly after that.
- Close the loop: reply in each feedback thread with what happened to it.
- The weekly survey count and the triaged-report count go into the plan's
  status line, as numbers, and only from the survey.
