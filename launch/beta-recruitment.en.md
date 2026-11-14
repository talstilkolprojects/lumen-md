# Beta recruitment: 50 testers and 12 self-guided tests (W6.31)

> **Nothing here is published or sent.** Recruiting is Tal's step: choose
> the channels, ask the group admins, and post. These files are the list and
> the drafts. The self-guided test invitation is in #487
> (`research/usability/invitation-self.he.md`).

## The goal

- **12 self-guided tests** (#487's test mode), median SUS ≥ 75.
- **50 active beta testers** in one week: Lumen opened on 3 or more of the
  7 days. Counted only from the weekly reports testers chose to send
  (`npm run beta:funnel -- --github`).

## Where to look (research, 12.11.2026)

| Community | Why it fits | How to reach it | Source |
|---|---|---|---|
| The National Union of Israeli Students, and the student union of each institution | Lecture notes in Hebrew are the main scenario of the tasks | Through the union's coordinators or faculty groups; ask before posting | [nuis.co.il](https://www.nuis.co.il/), [Kol Zchut: student unions](https://www.kolzchut.org.il/he/אגודת_הסטודנטים) |
| Users of Obsidian's RTL plugin | Already write Hebrew or Arabic in Obsidian, and know the problems Lumen solves | A discussion on the plugin's GitHub and the "RTL Support" thread on the Obsidian forum (within the forum's rules) | [esm7/obsidian-rtl](https://github.com/esm7/obsidian-rtl), [forum.obsidian.md/t/rtl-support/1438](https://forum.obsidian.md/t/rtl-support/1438), [obsidianstats: hebrew tag](https://www.obsidianstats.com/tags/hebrew) |
| A Hebrew Obsidian group | The audience for moving from Obsidian | **The search found no public group.** Ask in the channels above and in the developer communities whether a closed one exists | — |
| Ma'akaf | An Israeli open-source community; the project is open and wants contributors too | The community's WhatsApp and Discord | [maakaf.netlify.app](https://maakaf.netlify.app/en), [Hamakor: communities](https://hamakor.org.il/en/communities) |
| Israeli Python communities (PyWeb-IL, PyData Tel Aviv, …) | Developers who write Hebrew and English on one line | Meetup, WhatsApp, Telegram and Facebook, listed on the site | [python.org.il](https://python.org.il/en/), [Hamakor: communities](https://hamakor.org.il/en/communities) |
| GitHub User Group, Rust-TLV, Go Israel | Developers who live on GitHub, where feedback and reports go | Meetup | [Hamakor: communities](https://hamakor.org.il/en/communities) |
| Baot, Hackeriot | Communities of women in development and security; they balance the sample | Through the community managers | [baot.org](https://www.baot.org/), [hackeriot.org](https://www.hackeriot.org/) |
| Hebrew writers, translators and editors | Lots of Hebrew text, export to Word and PDF | The professional Facebook groups Tal knows | (Tal's own list) |

**Suggested order:** personal network first (the first 10–15), then
Obsidian's RTL users, then the student unions, then the developer
communities. A new channel only after the feedback from the last one is
triaged, as in `launch-plan.md`.

## Draft: the beta (short post)

> **Looking for 50 people who write in Hebrew for the Lumen beta**
>
> Lumen is a free, open-source note editor that starts from Hebrew:
> direction per line, search that understands prefixes and niqqud, and
> notes that stay with you.
>
> Join from inside the app: Command palette → "Help: Beta programme".
> Feedback goes as a GitHub issue you submit yourself, and a weekly usage
> report leaves only if you ask for it, with counts only. No notes, no ids.
>
> Details: https://lumen-md.vercel.app/beta.html

## What Tal does

1. Pick channels from the table and ask the group admins.
2. Post the draft, with #487's submission-form link for the self-guided test.
3. Once a week: `npm run beta:funnel -- --github --out funnel.md`, and the
   numbers go into the plan's status line.
4. The top 10 problems (from feedback and the tests) become tasks.
