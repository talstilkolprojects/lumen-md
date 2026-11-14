# Second maintainer and human reviewers: outreach kit (plan W6.13)

Lumen has one human maintainer. The crypto and sync code has been written and checked only by agents and Tal. This kit is for finding **a second maintainer** and **two human reviewers** for sensitive code. Tal sends every message himself.

| File | For |
|---|---|
| [outreach.he.md](outreach.he.md) | Three Hebrew drafts: a community post, a direct message to a contributor of a similar project, and a one-PR review request to a security person |

## The plan's acceptance and how to track it

| Acceptance (W6.13) | Where it shows |
|---|---|
| Within 30 days: a second maintainer, with a key in SECURITY.md | `SECURITY.md` → "Maintainers and keys" has a second row with fingerprints; `.github/CODEOWNERS` lists them |
| 2 human reviewers, each reviewed at least one sensitive PR | a `human-reviewed` label event by each of them on a PR that `npm run review:queue` listed |
| Median review time ≤ 3 days | the time between a PR entering the weekly queue and its `human-reviewed` label |

## Where to post (Tal)

- Israeli developer communities where self-promotion of open-source projects is allowed by their rules. Check each group's rules before posting.
- Direct messages work better than posts: people who have contributed to Markdown editors and note apps (Obsidian plugins, Logseq, Joplin, Zettlr), to Hebrew NLP or RTL tooling, or to WebCrypto and E2EE libraries.
- University security clubs and CTF teams, for the one-PR review request.

## What a newcomer gets on day one

- The guide: `docs/src/content/docs/contributing/second-maintainer.md` (Hebrew: `docs/src/content/docs/he/contributing/second-maintainer.md`).
- The week's queue: `npm run review:queue -- --base verify/train-2`, at most five PRs with questions, attack cases and the commands to run.
- No GitHub Actions to learn: every check runs on their own machine.
