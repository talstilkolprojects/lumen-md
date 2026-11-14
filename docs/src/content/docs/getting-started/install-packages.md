---
title: Install with a package manager
description: Install the Lumen desktop app with Homebrew, winget, Flatpak or the AUR, and where those packages come from.
---

Each release of the desktop app is published as a GitHub release. The
Homebrew cask, the winget manifests, the Flathub manifest and the AUR
package are all generated from that release's `SHA256SUMS`, so every
channel installs the same files.

| System | Command |
|---|---|
| macOS (Homebrew) | `brew install --cask lumen-md` |
| Windows (winget) | `winget install Talstilkol.Lumen` |
| Linux (Flathub) | `flatpak install flathub io.github.talstilkol.Lumen` |
| Arch Linux (AUR) | `yay -S lumen-md-bin` (or any AUR helper) |

A channel works once the owner has submitted that release to it. Until
then, download the installer from the GitHub release and check it with
`SHA256SUMS`.

## Updates

- Homebrew, winget, Flatpak and the AUR update the app like any other
  package.
- The app's own updater ([Desktop app updates](/getting-started/desktop-updates/))
  stays on, and checks the same signed release.

## The Flatpak sandbox

The Flatpak app may use the network (sync, model downloads, and cloud AI
when you allow it) and your `Documents` folder. A vault in any other
folder opens through the system's file picker, which grants access to
that folder only.

## For maintainers

`node scripts/release.mjs packages` writes every manifest and checks it
offline. See `RELEASE.md`, "Stores and package managers".
