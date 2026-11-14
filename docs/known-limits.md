# Known limits

Findings that were reviewed and deliberately left as they are, each with the
reason. Plan W1.32 (15.16 item 11) closed every Codex P2 finding left open
on the PRs of 18.10: each was either fixed with a test (see the commits
"W1.32, Codex P2 on #…") or is listed here.

| Finding | Decision | Why |
|---|---|---|
| #235 — freeze vault writes from the move's final check until the switch | Not fixed | `moveVault` lists and re-verifies every file after the copy and stops (resumable) when a note was added, removed or changed, so a write is lost only if it lands in the few milliseconds between that check and the switch (two IndexedDB writes). Closing that window means holding every vault write in the backend gate (src/storage/vault/index.ts) and redirecting the held ones to the new backend, which the encryption layer also passes through. That change needs browser tests of concurrent saves during a move; it is not worth the risk to the core write path for a window this narrow. |
| #238 — escapes typed in the WYSIWYG editor | Fixed in part | A `\[\[x]]` typed as text is now saved escaped (`\[\[x]]`), never as a live link. Two cases stay: a typed `\[[x]]` (one backslash) is kept as a backslash followed by a link, because it is the same text as the source `\\[[x]]`, which means exactly that; and a source that spells out literal backslashes (`\\\[\\\[x]]`) is saved as the escaped link `\[\[x]]` after a WYSIWYG edit (shown the same, never a live link). |
| 15.16 (11) — manual check: Hebrew-named notes inside a folder vault in regular Chrome | Owner | Needs a real Chrome with the File System Access API and a picked folder; the automated tests use a fake folder. |
