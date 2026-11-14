---
title: Git sync
description: Clone, pull and push a git repository from Lumen — safely. A pull merges, never deletes, and never overwrites a note you are editing.
---

Lumen can keep a folder of your vault in step with a git repository. Everything runs in the app (via [isomorphic-git](https://isomorphic-git.org)); there is no Lumen server in between.

Commands (⌘K):

| Command | What it does |
| --- | --- |
| **Git: clone repository…** | Copies a repository into a folder of the vault. |
| **Git: pull current repo** | Fetches and merges the remote into that folder (see below). |
| **Git: commit & push current repo…** | Saves every open note with unsaved edits first (tabs included), then commits the folder and pushes it. A note whose file was changed outside Lumen in the meantime is left out of the commit and listed, so the conflict can be resolved first. |
| **Git: status (current repo)** | Added / modified / deleted files. |
| **Git: toggle watch-mode auto-pull** | Pulls every 5 minutes while the tab is visible. |
| **Git: set CORS proxy…** | The proxy git requests go through in a browser. |
| **Git: set access token…** | Only needed for private repositories and for pushing. |

## What a pull does (and never does)

A pull is **fetch + three-way merge** into the vault:

- A file only the remote changed is updated.
- A file you changed and the remote did not is left alone.
- A file both of you changed is merged line by line. Edits to different lines merge on their own.
- Edits to **the same lines** are a **conflict**. The file then holds both versions between the usual markers:

  ```text
  <<<<<<< local
  your line
  =======
  their line
  >>>>>>> remote
  ```

  The resolution screen opens for each conflict: keep yours, take theirs, or pick per hunk. If you choose **Resolve later**, the markers stay in the file, and **commit refuses** until they are gone, so markers never get pushed by accident. Before a conflicted or merged file is rewritten, its previous text goes into Version History ("before git pull").

What a pull **never** does:

- **It never deletes a file.** A file deleted upstream stays in your vault, and the pull says which. Delete it yourself if you want it gone.
- **It never touches files git does not track.** Your own notes in the repository folder are not looked at.
- **It never overwrites a note open with unsaved edits.** A clean merge goes into the editor and is saved the normal way. On a conflict the note is left exactly as it is, and the remote version is kept next to it as `name (git 1a2b3c4).md`.
- **It never merges binary files.** If both sides changed an image, yours stays and theirs is kept as a copy.

Cloning into a folder that already exists keeps every file that is already there. Files already there with different content are counted, not overwritten.

### Shallow clones

A clone fetches only the latest commit (depth 1). A merge needs the commit both sides share (the *merge base*), so when a pull cannot find it, Lumen deepens the clone automatically: 50, then 500, then 5,000 commits, and finally the full history.

## Public repositories need no token

Clone and pull work on public repositories without a token. You need a token (GitHub: a fine-grained personal access token with *Contents: read & write*) only for private repositories and for pushing. The token stays on this device in the encrypted secret store.

## CORS proxy

Browsers only let a page talk to servers that allow it (CORS), and GitHub, GitLab and most git hosts don't allow it for git traffic. In the browser, git therefore goes through a **CORS proxy**. The desktop app and git servers that send CORS headers don't need one.

**Lumen has no built-in proxy.** Choose one of these:

1. **Run one on this machine** (recommended):

   ```sh
   docker compose -f docker/git-proxy.yml up -d
   ```

   Then go to ⌘K → **Git: set CORS proxy…** → `http://localhost:9999`. Lumen's Content-Security-Policy already allows `localhost:9999`.

2. **A proxy your deployment hosts.** Build with `VITE_GIT_CORS_PROXY=https://git-proxy.example.com`. The build adds that origin to the CSP `connect-src`, and it becomes the default for every user. A user's own setting (option 1) still takes precedence.

The proxy is [@isomorphic-git/cors-proxy](https://github.com/isomorphic-git/cors-proxy) (MIT). It forwards only git smart-HTTP requests and stores nothing. Your token passes through it in the `Authorization` header, so only use a proxy you trust.

If a clone or pull fails before it reaches the git host, Lumen says so and points to this setting.

## Git LFS is not supported

Repositories that use [Git LFS](https://git-lfs.com) store large files as small *pointer* files, and the real content lives on a separate LFS server that Lumen does not talk to. What happens:

- A clone writes the pointer files as they are and lists them, so you know those files are not the real content.
- A pull **never replaces a real file with a pointer**. If the vault has the real file and upstream has a pointer, the file is kept and reported.
- A commit **never replaces a pointer with the real file**: the repository keeps its pointer and the commit tells you which files it kept that way, so a large file is not pushed as an ordinary Git object and the repository's LFS tracking stays intact.

To work with LFS content, check the repository out with the git command line and open that folder as your vault.
