---
title: Quick capture (inbox)
description: Add a thought, task or link to inbox.md in two steps, from the keyboard, the home screen or the share sheet.
---

Quick capture adds one entry to the end of `inbox.md`, at the root of
your workspace. It takes two steps: open the capture box, type and press
Enter. You stay in the note you were working on. (Sharing is the
exception: it opens the inbox afterwards.)

Each entry is a list item that links to that day's
[daily note](#how-an-entry-looks) and records the time:

```markdown
# Inbox

- [[journal/2026-10-20]] 09:05 call the plumber
- [[journal/2026-10-20]] 14:30 Shared page <https://example.com/a>
  the text that was shared with it
```

If `inbox.md` doesn't exist, the first capture creates it with an
`# Inbox` heading. Quick capture only ever adds text after the last
character of the file. It never changes or reorders what is already
there. If the inbox is open in a tab with unsaved edits, the entry is
added to that open text, so your edits are kept.

Hebrew and other right-to-left text is saved exactly as you typed it,
including bidi marks. The capture box sets its direction from the first
letter you type.

## Opening the capture box

| Where | How |
|---|---|
| Any browser, the installed app, the desktop app | `⌥⌘N` (Windows / Linux: `Ctrl+Alt+N`) or **Quick capture** in the command palette (`⌘K`) |
| Installed app (PWA), home screen / dock / taskbar | Long-press or right-click the Lumen icon, then **Quick Capture**. This opens `/?capture=1`. |
| Desktop app (Tauri) | **File ▸ Quick capture…**, or `⌥⌘N` in the window |

On Windows and Linux, `Ctrl+Alt+N` is skipped when it is really AltGr+N
(which types a letter such as `ń` on some layouts).

In the box, **Enter** saves, **Shift+Enter** starts a new line and
**Esc** closes. **Open inbox** opens `inbox.md` in a tab.

## Sharing to Lumen (Android)

When Lumen is installed as an app on Android, it appears in the system
share sheet. Anything you share to it is added to the inbox as one entry:
the title and link first, then the shared text on the next line. Lumen
then opens the inbox. If this browser can't provide a workspace (no
OPFS), the shared item opens as a new note instead.

The share target uses `GET /?title=…&text=…&url=…`. Only text and links
can be shared. Sharing files would need a POST share target and a custom
service worker.

Sharing from the native iOS and Android apps (Capacitor) is a separate
feature, planned with the native apps (plan 13.3).

## How an entry looks

- `[[…]]` is the path of that day's daily note (folder and file name,
  without `.md`), built from your daily-note folder and file pattern (**Calendar ▸ Daily note settings**). If that
  note doesn't exist yet, the capture creates it from your daily-note
  template, so the link always opens it. An existing daily note is never
  changed.
- The time is your device's local time, as `HH:MM`.
- Blank lines before and after the text are removed, as are spaces at
  the ends of lines. All other lines are indented by two spaces so they
  stay inside the list item.

## A system-wide shortcut on the desktop

In a browser and the installed PWA, `⌥⌘N` works while Lumen's window has
the focus. A shortcut that works from any app needs Tauri's
global-shortcut plugin, which the desktop app doesn't bundle yet. The
frontend already checks for it at startup
(`src/capture/desktopShortcut.ts`). On macOS it registers `⌥⌘N`
(`Alt+Command+N`) when the plugin is there, and otherwise does nothing.
On Windows and Linux it registers nothing: there `Ctrl+Alt+N` is also
what many keyboard layouts send for AltGr+N, and a system-wide shortcut
can't tell them apart, so typing that letter in any app would open Lumen.
To turn it on in your own build:

1. `src-tauri/Cargo.toml`, under the desktop dependencies:
   `tauri-plugin-global-shortcut = "2"`
2. `src-tauri/src/lib.rs`, in `run()` under `#[cfg(desktop)]`:
   `app.handle().plugin(tauri_plugin_global_shortcut::Builder::new().build())?;`
3. `src-tauri/capabilities/default.json`: add
   `"global-shortcut:allow-register"` and `"global-shortcut:allow-unregister"`.

After that, on a Mac, pressing `⌥⌘N` anywhere brings Lumen to the front with the
capture box open. The window permissions this needs (`show`,
`unminimize`, `set-focus`) are already granted.
