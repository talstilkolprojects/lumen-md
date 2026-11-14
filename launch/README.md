# Launch materials — the Hebrew beta (plan W2.25)

**Nothing in this folder is published or sent.** It's material for Tal, who
decides when and where. The plan's goals (≥ 50 active testers, ≥ 30 triaged
reports) need people, so they are Tal's to reach.

| File | What it is |
|---|---|
| [`checklist.md`](checklist.md) | Every step before and after the launch, with an owner box for each |
| [`launch-plan.md`](launch-plan.md) | Where to announce, in what order, and draft posts (Hebrew communities and lists, Show HN, Product Hunt) |
| [`landing-copy.he.md`](landing-copy.he.md), [`landing-copy.en.md`](landing-copy.en.md) | Landing copy: headline, pillars, audience, calls to action, what's missing, FAQ |
| [`press-kit.md`](press-kit.md) | One line, one paragraph, checkable facts, the screenshot list, name and logo use |
| [`comparison.json`](comparison.json) | The comparison with Obsidian, Notion and Google Docs: every claim with its source and the date it was checked. `npm run launch:check` generates `docs/project/compare` from it, and `--strict` fails while any claim is unverified |
| [`survey.md`](survey.md) | The voluntary weekly survey, the only way active testers are counted |

Also part of the launch:
- [`public/beta.html`](../public/beta.html): the beta page, Hebrew-first;
- [`COMMUNITY.md`](../COMMUNITY.md) and [`COMMUNITY.he.md`](../COMMUNITY.he.md): the community guide;
- [`CODE_OF_CONDUCT.he.md`](../CODE_OF_CONDUCT.he.md): the code of conduct in Hebrew;
- `.github/DISCUSSION_TEMPLATE/`: the beta sign-up and feedback forms.

## The beta page and data

- `public/beta.html` makes **no request** of its own: no analytics, fonts,
  scripts or cookies from elsewhere.
- Joining is the person's own click to GitHub Discussions.
- The only thing the page keeps is the language choice, and that the join
  link was opened. Both stay in that browser.
- **The e-mail list is a seam, off by default.** If one is wanted, it is the
  owner's choice:

  | Option | Notes |
  |---|---|
  | No list (default) | GitHub only; nothing to run, nothing to hold |
  | A form service (e.g. Buttondown, Tally) | quick; their privacy terms apply; add its origin to `connect-src` |
  | A small worker of our own (like the edge workers in DEPLOY.md) | most control; we hold the addresses and must delete on request |

  Then set `data-signup-endpoint` on `<body>`. The page posts only
  `{ email, consent: true, lang }`, and only after the consent box is ticked
  and the button pressed.
