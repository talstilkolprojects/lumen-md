# Launch checklist — the Hebrew beta

> Owner: Tal. Tick each box in a PR, so the history shows who checked what.
> Nothing in this repository posts or sends anything; these are the steps a
> person takes.

## Product

- [ ] The beta build deploys separately from stable (plan 14.4: `release.mjs prepare --beta`, `deploy-beta`).
- [ ] The beta web app opens on a fresh browser, in Hebrew, offline after the first visit.
- [ ] *Send feedback* in the app opens a prefilled GitHub issue (plan 14.2).
- [ ] Export the whole vault works, and the import of that export round-trips. Testers need a backup.
- [ ] The landing page (`public/landing.html`): replace the comparison table with a link to `docs/project/compare`. The current table has no sources.

## Facts

- [ ] `npm run launch:check -- --strict` passes: every claim in `launch/comparison.json` is verified, with the date it was checked.
- [ ] Nothing on the landing page, the beta page or the press kit claims more than the docs say.

## Community

- [ ] GitHub Discussions turned on, with the categories **Beta** (slug `beta`), **Beta feedback** (slug `beta-feedback`), **Q&A** and **Show and tell**. The forms in `.github/DISCUSSION_TEMPLATE/` match the slugs.
- [ ] `COMMUNITY.md` and `COMMUNITY.he.md`: the private reporting address filled in.
- [ ] `CODE_OF_CONDUCT.md` and its Hebrew translation linked from the README and the Discussions welcome post.
- [ ] A pinned welcome post in *Beta* (Hebrew and English) linking the community guide, the survey and how to send feedback.

## Beta page

- [ ] `public/beta.html` is reachable on the beta site.
- [ ] If an e-mail list is wanted, the owner chooses the service and:
  - sets `data-signup-endpoint` on `<body>`;
  - adds that origin to `connect-src` in the site CSP (`vercel.json` / `deploy/nginx.conf`);
  - writes the retention and deletion terms into the consent text.

  Otherwise it stays hidden, and GitHub is the only way to join.

## Assets

- [ ] Screenshots from the list in `launch/press-kit.md`, Hebrew and English, light and dark, made-up notes only.
- [ ] The press kit's contact address filled in.

## Launch

- [ ] The order and drafts in `launch/launch-plan.md` reviewed; each post adapted to the group's rules.
- [ ] The first weekly survey is scheduled (`launch/survey.md`).

## After two weeks

- [ ] ≥ 50 active testers (survey) and ≥ 30 triaged reports, or a note on why not and what changes.
