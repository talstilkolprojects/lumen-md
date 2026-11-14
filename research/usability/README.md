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
