---
title: Widgets, Shortcuts and Siri
description: A Lumen widget on the home screen, Siri and Spotlight on iPhone, App Shortcuts on Android, and "Add to inbox" from the Shortcuts app — plus the steps to build them.
---

Lumen is one tap away on the phone, in Hebrew and in English.

## On the home screen

The **Lumen widget** (iPhone and Android) has three buttons:

- **Search** opens search.
- **Quick note** opens the quick-capture box with the cursor in it.
- **Today** opens today's daily note.

The widget shows no note text. In Hebrew the buttons run right to left.

## Siri, Spotlight and Shortcuts (iPhone)

These work without setup. Say them to Siri, type them in Spotlight, or
find them in the Shortcuts app:

| Say or search | What happens |
|---|---|
| "Add to Lumen inbox" | Siri asks what to add and adds it to the end of `inbox.md`, without opening Lumen |
| "Quick note in Lumen" | opens the quick-capture box |
| "Voice note in Lumen" | opens the box, recording |
| "Search Lumen" | opens search (and, from Shortcuts, with your query) |
| "Today's Lumen note" | opens today's note |

In Hebrew: "הוסף לתיבת הלכידה של Lumen", "פתק מהיר ב-Lumen", "חפש
ב-Lumen" and so on.

*Add to inbox* works even when Lumen is closed. The text waits on the
phone, and the next time Lumen opens it lands in `inbox.md` with the time
you said it. Each line is added once, and nothing is lost if Lumen is
closed again first.

## App Shortcuts (Android)

Long-press the Lumen icon: **Quick note**, **Voice note**, **Search** and
**Today**. Drag one to the home screen to keep it there.

## Links for other apps

Every widget button and shortcut is a link, which other apps and
automations can use too:

| Link | What it does |
|---|---|
| `lumen://capture` | opens the quick-capture box |
| `lumen://capture?mode=voice` | opens the box, recording |
| `lumen://capture?text=…` | adds the text to the inbox |
| `lumen://new` | opens a new note |
| `lumen://search?q=…` | opens search with the query |
| `lumen://daily` | opens today's note |

## For maintainers: building them

The native parts follow one rule: they only forward a link or a queued
line to the app. What a link means is decided in
`src/mobile/nativeActions.ts`, which is tested
(`src/__tests__/widgets.test.ts`). The Android link helper is
`LumenActions.java`, plain Java checked with `javac`.

### iOS (Xcode)

The Xcode project already holds everything (`ios/App/App.xcodeproj`,
checked by `src/__tests__/iosProject.test.ts`):

- the **App** target compiles `AppDelegate.swift`, `LumenNative.swift`,
  `LumenIntents.swift` and `iCloudSync.swift`, with `en.lproj` / `he.lproj`
  (`Localizable.strings`, `AppShortcuts.strings`); Hebrew is a project
  localization;
- the **LumenWidgets** widget extension (`com.lumen.editor.LumenWidgets`)
  compiles `LumenWidgets/LumenWidgets.swift` with its own strings,
  `Info.plist` and entitlements, and the app embeds it;
- both targets have the App Group `group.com.lumen.editor` in their
  entitlements (the share extension's queue is read through it).

To build:

1. `npm run build && npx cap sync ios`, then open `ios/App/App.xcworkspace`
   (or `App.xcodeproj` with Swift Package Manager).
2. **Signing:** set the same team for the App and LumenWidgets targets
   (the accounts are in plan 15.7), and register the App Group
   `group.com.lumen.editor` for both bundle ids in the developer account.
3. `Main.storyboard` already uses `MainViewController`, which registers the
   app's plugin. Check that its class shows *Module: App*.
4. Build and run on a device. Long-press the home screen → **+** →
   **Lumen** to add the widget.

### Android (Android Studio)

Everything is in the project already: the widget (`LumenWidgetProvider`,
`res/layout/widget_lumen.xml`, `res/xml/widget_lumen_info.xml`), App
Shortcuts (`res/xml/shortcuts.xml`), the `lumen://` intent filter, and the
plugin, which `MainActivity` registers.

1. `npm run build && npx cap sync android`, then open `android/` in
   Android Studio.
2. Build → Make Project, then run on a device or an emulator (API 26 or
   later).
3. Long-press the home screen → **Widgets** → **Lumen** to add the widget.
   Long-press the app icon for the shortcuts.

### Manual checks on real devices

The plan asks for these to be done and written down, on an iPhone and an
Android phone, with the phone in Hebrew and then in English:

1. **Tap → typing under 1 second:** record the screen at 60 fps, tap
   *Quick note* on the widget, and count frames from the tap to the
   blinking cursor. The app also logs `widget tap → typing` from the moment
   it receives the link, which leaves out the system's launch time.
2. **Siri:** say "Add to Lumen inbox" and then a sentence, with Lumen
   closed. Open Lumen: the sentence is at the end of `inbox.md`, with the
   time you said it.
3. **Shortcuts app:** make a shortcut with *Add to Lumen inbox* and run it.
   The same result.
4. **RTL:** with the phone in Hebrew, the widget buttons run right to left
   and the labels are in Hebrew. The same holds for the App Shortcuts.
5. **Each link:** `lumen://search?q=test` from the browser opens search
   with "test".
