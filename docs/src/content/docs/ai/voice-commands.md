---
title: Voice commands, on this device
description: Say "new note", "search…" or "add task…" in Hebrew or English. Lumen recognises the speech and the command locally, and asks before anything that deletes.
---

Run **Voice command** from the command palette, then say one command. Lumen
listens for one sentence (up to 8 seconds), recognises it with the
dictation model on your device, and runs the matching command. Nothing is
sent anywhere: the speech model is the one dictation already downloaded,
and the command is matched against a fixed list of phrases.

The first time, start dictation once to download the model (74 MB).

## What you can say

| Say (Hebrew / English) | What happens |
|---|---|
| ״צור פתק חדש בשם…״ / "new note called…" | A new note, with the title as its heading |
| ״חפש…״ / "search for…" | Search opens with your words in the box |
| ״הוסף משימה…״ / "add a task…" | A checkbox line in the inbox |
| ״פתח את הפתק היומי״ / "open the daily note" | Today's note |
| ״הקרא״ / "read aloud", ״הפסק להקריא״ / "stop reading" | Reads the note aloud, or stops |
| ״לכידה מהירה״ / "quick capture" | The quick-capture window |
| ״פתח משימות״ / "show my tasks" | The tasks panel |
| ״מחק את הפתק״ / "delete this note" | Asks first, then moves the note to the trash |
| ״שמור״ / "save" | Saves |
| ״סכם״ / "summarize", ״תרגם״ / "translate" | The AI summary or translation |
| ״הכתבה״ / "start dictation" | Dictation |
| ״מצב כהה״ / "dark mode" | Switches the theme |
| ״הגדרות״ / "settings", ״לוח שנה״ / "calendar", ״תצוגת גרף״ / "graph view" | Opens them |
| ״תוכן עניינים״ / "outline", ״קישורים חוזרים״ / "backlinks" | The side panels |
| ״בדוק דקדוק״ / "check grammar" | The grammar check |

You can say "please" or "um", start with "hey Lumen", and a "ו" glued to
the first word is fine. An ordinary sentence ("save the date for the
wedding") runs nothing, because a command must be the whole sentence.

## How it's measured

The phrase list was written against 200 spoken commands, 10 per command,
in Hebrew and English. It gets all 200 of them right, and runs nothing on
20 ordinary sentences. Because the list was written for those 200, that
isn't a real test. The real one is 200 commands **recorded** by different
speakers, played through the speech model:

```sh
npm run eval:voice-commands -- --script > commands.json   # the 200 sentences to read aloud
npm run eval:voice-commands -- --dir <folder with commands.json and the recordings>
```

The target is at least 90% right. The same run is a step of
`npm run models:day -- --voice-dir <folder>`.
