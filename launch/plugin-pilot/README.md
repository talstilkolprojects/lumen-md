# Plugin pilot: five outside developers (plan W6.35)

A ready kit for asking five developers who are not part of the project to build one Lumen plugin each with `create-lumen-plugin`, and for turning everything that slows them down into a task.

| File | What it is | Who uses it |
|---|---|---|
| [invitation.he.md](invitation.he.md) | The invitation in Hebrew | Tal sends it |
| [invitation.en.md](invitation.en.md) | The invitation in English | Tal sends it |
| [feedback-template.md](feedback-template.md) | The feedback form, Hebrew and English, with the timing log | Each developer fills it in |
| [`.github/ISSUE_TEMPLATE/plugin-pilot.yml`](../../.github/ISSUE_TEMPLATE/plugin-pilot.yml) | The same form as a GitHub issue | Developers who prefer GitHub |

## The plan's acceptance and how the kit measures it

| Acceptance (W6.35) | How it is measured |
|---|---|
| 5 plugins by outside developers in the registry | Each pilot plugin arrives as a pull request adding `public/plugins/examples/<name>/`. It counts when `node scripts/build-plugin-registry.mjs --check` passes and the PR is merged by Tal. `npm run registry:site` then puts it on the registry site. |
| Median time from zero to a first plugin ≤ 30 minutes | The feedback form has a timing log with four marks: start (nothing installed), scaffold done, the plugin ran in Lumen, the test passed. "First plugin" is the third mark. The median is over the five developers. |
| Every problem becomes a task | Every "stuck" row in the timing log and every answer to "What slowed you down?" becomes a line in the plan (the coordinator adds it as a wave task, with the developer's words as the source). |

## Who to ask

Five people, with different backgrounds, so the kit is tested by different kinds of developers:

1. A JavaScript developer who has written an Obsidian plugin.
2. A developer who writes Hebrew or Arabic interfaces (RTL).
3. A student (for example from a university programming course or a bootcamp).
4. A backend or data developer who rarely writes frontend code.
5. Someone who builds tools for writers, researchers or note-takers.

Good places: Israeli developer communities (the Hebrew invitation), the Obsidian forum's "Developers & API" category and the Obsidian Discord (the English invitation). Post where the community's rules allow it, and prefer a direct message to someone who already wrote a plugin.

## What the developer needs

- Node.js 18 or newer. Nothing to install with npm: the template has no dependencies.
- The app at https://lumen-md.vercel.app (or a local `npm run dev`).
- Until `create-lumen-plugin` is published to npm, the scaffold runs from a clone:
  `git clone https://github.com/talstilkol/lumen-md && node lumen-md/packages/create-lumen-plugin/bin.js my-plugin`.
  After Tal publishes it (`cd packages/create-lumen-plugin && npm publish`), it is `npx create-lumen-plugin my-plugin`.

Checked here (W6.35): the scaffold from a clone, then `npm test` in the new folder, passes with no install.

## The flow, per developer

1. Tal sends the invitation (Hebrew or English).
2. The developer replies yes and names an idea. If they have none, offer one of the ideas in the invitation.
3. The developer starts the timer, follows the five-minute walk-through in the template's README, and writes down each mark.
4. They open a pull request with the plugin folder, and send the feedback form (as a file, an email, or the GitHub issue form).
5. Within 3 days: Tal (or the second maintainer) reviews the PR. The coordinator turns each problem into a task.
6. A short thank-you, and their name on the plugin's card (the manifest's `author`).

## What is in scope for a pilot plugin

Anything the sandbox allows: commands, a side panel, a code-block renderer, settings, storage, reading and writing notes with permission. A plugin that asks for network access is fine, but it needs a clear reason, and it will not work under the local-only AI policy.
