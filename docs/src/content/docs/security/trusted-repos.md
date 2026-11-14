---
title: Trusted repositories
description: Let agents propose changes in a git repository you own without the extra outside-content question.
---

Notes that come from a **git clone or pull** are *outside content*:
someone else may have written them, and they may hide instructions for
an agent (see [Local agents → Outside content](/ai/local-agents/#outside-content-prompt-injection)).
So when an agent has read such a note, every change it proposes asks you
first, before it is even staged.

For a repository that is yours, such as your own notes repo or a repo
only your team pushes to, that question gets in the way. **Trust this
repo** turns it off for that repository.

## Turn it on

1. Open the command palette (⌘K) and run **Trusted repositories…**
   (group *Security*).
2. Every repository cloned in this browser is listed with a switch. All
   of them start as **Asks first**.
3. Turn the switch on and confirm. The repository is now **Trusted**.

The setting is saved **on this device only**. It is not synced, not
written into the repository, and not shared with collaborators.

## What changes

With the switch on, when everything outside in an agent's run comes from
trusted repositories:

- a change the agent proposes is **staged without the extra question**;
- the change still **waits for your review** in the staged changes list.
  Nothing is written until you apply it.

## What stays the same

- The repository's notes are still **delimited and cleaned** in the
  prompt, and the run still records that it read outside content.
- **Web requests still ask** (fetch a page, search the web): that is how
  text planted in a note could send your data out.
- Anything else outside in the same run asks as before: a clipped page,
  an imported folder, a web result, another repository that is not
  trusted, or a note in the trusted repository whose frontmatter says
  `untrusted: true`.

## When trust is dropped

Trust belongs to the repository you looked at, so it is removed when:

- you **clone again** into the same folder;
- you **rename or move** the repository folder, or move another folder
  onto its name.

Moving notes *inside* a trusted repository keeps it trusted. Turn the
switch off at any time to make agents ask again.

## Who should not use it

Anyone who can push to the repository can put text in front of your
agents. Do not trust a repository with outside contributors, a fork of
someone else's project, or a repository whose push access you don't
control.
