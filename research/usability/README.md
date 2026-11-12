# Usability tests with Hebrew-speaking users (plan W1.29)

> **Status: the kit is ready; the sessions are not run yet.** Tal runs round 1
> (5–8 participants), the 10 most severe issues become plan tasks, and round 2
> (5–8 new participants) checks the fixes. Acceptance: mean SUS ≥ 80 in round
> 2, ≥ 90% unaided success on the 10 tasks, 10/10 severe round-1 issues closed.

| File | What it is |
|---|---|
| [`protocol.he.md`](protocol.he.md) | The session, in Hebrew: setup, the script read aloud, moderator rules, the **10 tasks** with success criteria and time limits, the ease question (SEQ) after each task, the **SUS** questionnaire, debrief, and what to do after |
| [`recruitment.he.md`](recruitment.he.md) | The call for participants, a personal message, and the screener (2 students, 2 researchers, 2 writers, 2 developers) |
| [`consent.he.md`](consent.he.md) | The consent form: what is recorded and what isn't, optional screen recording and quotes, deletion after analysis |
| [`findings-template.he.md`](findings-template.he.md) | Issues with Nielsen severity, frequency and evidence, per-task results, the round-2 acceptance table; `usability-analyze.mjs --findings` reads its issues table |
| [`seed-vault/`](seed-vault) | The notes the tasks use, all made up. Import them before each session, then delete “טיוטה ישנה” so it waits in the trash for task 9 |

## Self-guided round (plan W4.25)

So the first round does not depend on Tal alone: **5 moderated sessions** (Tal,
`protocol.he.md`) plus **at least 7 self-guided ones**. Acceptance: ≥ 12
participants, mean SUS ≥ 75, and every severe finding has a plan task.

| File | What it is |
|---|---|
| [`unmoderated.he.md`](unmoderated.he.md) | The self-guided protocol: how it runs, what the app does in the moderator's place, outcome rules, what is and isn't recorded, collection and analysis |
| [`tasks-self.he.md`](tasks-self.he.md) | The ten task scripts as participants see them, and what the app checks (a test keeps them equal to the code) |
| [`tools.he.md`](tools.he.md) | The free-tool research and the decision: the app's own self-guided mode, plus a free Tally form to receive the file |
| [`invitation-self.he.md`](invitation-self.he.md) | Channels and wording for recruiting (**Tal's step**) |
| [`submission-form.he.md`](submission-form.he.md) | The Tally form to set up (**Tal's step**) |

In the app: Command palette → **Usability test (self-guided)…**
(`src/ui/UsabilitySelfPanel.tsx`, `src/research/usability/unmoderated.ts`).

- **Opt-in, consent first.** Nothing is recorded before consent.
- **Random code.** The participant gets a code like `U-7K3F`, never a name.
- **Practice notes.** The panel writes them into the folder `בדיקת שימושיות` and puts `טיוטה ישנה` in the trash for task 9.
- **Tasks.** Each task shows its script, a timer, and **Done** / **I couldn't do it**, then the ease question. SUS comes at the end.
- **Result check.** Where a task's result is in the notes, the app checks it on the device and records only **yes or no**.
- **Export.** The participant saves a `.zip` (the session JSON and a README) and sends it through the form.
- **Analysis.** `usability-analyze.mjs` reads `.zip` and `.json` files together, splits moderated from self-guided sessions, and checks the W4.25 acceptance.

## In the app: the session recorder

Command palette → **Usability study (moderator)…**
(`src/ui/UsabilitySessionPanel.tsx`, `src/research/usability/sessionRecorder.ts`).

- **Consent first.** The session starts only with a participant code (P1…P20,
  never a name) and the consent box ticked. The API refuses without them too.
- **Local only.** Events live in this browser's storage, so a reload loses
  nothing. They leave only as the JSON file the moderator saves. The recorder
  makes no request.
- **No content.**
  - Clicks are kept by role, with the label only when it is one of the app's
    own UI strings; any other label becomes `[label]`.
  - Keys are counted, and only modifier shortcuts are named.
  - Commands are recorded by id; ids that carry a name are reduced to their
    family.
- **Deleted.** *Delete session data* removes it from the device; anything left
  is removed after 30 days.

## Analysis

```bash
node scripts/usability-analyze.mjs sessions/ --round 1 --out report-r1.md
node scripts/usability-analyze.mjs sessions/ --round 2 --findings research/usability/findings-template.he.md
```

Per task, the report gives:
- attempts;
- success, success without help, and success including partials;
- median time;
- SEQ;
- errors and help opened.

It also gives SUS per participant and the round's mean with a 95% confidence
interval (t distribution). For round 2 it adds the plan's acceptance checks.
With 5–8 people the numbers show direction, not significance.

Session files hold no names or note text, but they are research data: keep
them out of the repository, and delete them once the round's analysis is
written, as the consent form promises.
