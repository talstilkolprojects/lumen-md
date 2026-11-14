---
title: Beta channel and feature flags
description: Try new features before everyone else, on the web or in the desktop app, and turn any beta feature on or off on your own device.
---

New features reach a **beta** first, then a stable release after testing.

## The beta

- **On the web:** the beta is a separate site, built from the same code,
  with new features turned on. A **Beta** badge in the status bar shows you
  are on it. Your notes stay in your browser as usual: the beta and the
  stable site are separate origins and don't share storage. To move notes
  between them, keep the vault in a folder on disk and open that folder in
  both, or export from one and import into the other.
- **In the desktop app:** command palette → **Update channel: switch between stable and beta**. Beta also
  installs beta releases; stable installs only tested releases. If you go
  back to stable, you stay on your current version until a stable release
  is newer, because the app never installs an older version.

Betas are numbered like `0.2.0-beta.1`. Once a beta has been tested, the
same changes ship as `0.2.0`.

## Feature flags

Each feature in beta has a flag. Command palette → **Feature flags…**
(or tap the **Beta** badge) lists them:

- **On or off:** turn any flag on or off for yourself. In a stable build
  you can try a beta feature; in a beta build you can turn one off.
- **Where the value comes from:** *Default for this build*, or *Your
  choice*, with a link back to the default. **Reset all** clears your
  choices.
- **Private:** flags are local. Lumen doesn't fetch them from a server and
  doesn't report them anywhere. Your choices stay in this browser or app.

Features in beta now:

| Flag | What it does |
|---|---|
| Check for updates at launch | Desktop app: looks for a new version once a day when Lumen starts, so beta fixes arrive quickly. Never in *local only* mode; every check is in the privacy log. |

## How a feature graduates

A feature ships first in a beta with its flag on. A later release promotes
the flag to stable, and the feature is on for everyone. The project's
release check refuses a flag that reaches stable without an earlier beta.
