---
title: Compiling the native code offline
description: How Lumen's Rust, Java and Swift code is compiled without crates.io, the Android SDK or Xcode — what the check proves, what it cannot, and what still needs a Mac.
---

Lumen has native code next to the web app: the Tauri desktop shell in
`src-tauri/` (Rust), the Android plugins and widget (Java), and the iOS
extensions (Swift). A full build needs crates.io, the WebKitGTK headers, the
Android SDK with Google's Maven repository, or Xcode. When none of those are
reachable (an offline sandbox, a plane, a blocked network), run:

```sh
bash tools/native-check/run.sh
```

It needs only `rustc` and `javac` (JDK 17 or newer), and finishes in about
ten seconds.

## What it checks

| Step | What runs | What a pass proves |
|---|---|---|
| 1. Std-only crates | `rustc --test` on `src-tauri/desktop`, `keychain`, `vault`, `src/whisper_core.rs` | The code compiles and its unit tests pass — for real, no stubs. |
| 2. The Tauri glue | `rustc` on `src-tauri/src/lib.rs` + `main.rs` against `tools/native-check/rust-stubs/`, once with `--cfg desktop` and once with `--cfg mobile` | Every module, import, type, borrow and lifetime checks out against the signatures of tauri 2 and its plugins. |
| 2. Commands | the stub `#[tauri::command]` | Each argument is a command argument (Deserialize, `State`, `AppHandle`, `Window`, `Request`), each return value is an IPC response, every async command's future is `Send`, and an async command that borrows returns a `Result` — the rules the real macro enforces. |
| 2. Cargo.lock | `lockcheck.mjs` | Every dependency in `Cargo.toml` is in `Cargo.lock`: `cargo check --locked` would not refuse it. |
| 3. Android | `javac -Xlint:all -Werror` on `android/app/src/main/java` and `mobile/android` against `java-stubs/`, with an `R` class generated from `res/` | The Java compiles with no warnings; every `@string`, `@xml`, `@layout`, `@drawable`, `@mipmap` and `@style` reference exists. |
| 4. Swift | listed only | Nothing: Swift needs Xcode. |

## What it cannot prove

The stubs hold signatures, not behaviour. They were copied from tauri 2 and
from the plugin sources (tauri-plugin-dialog, -deep-link, -single-instance,
-updater, -fs) at the versions in `Cargo.lock`. A stub can be wrong, and when
the code uses an API the stubs lack, add it there **from the real source**,
never to make an error go away. These still need the real tools:

- `cargo check --locked` / `npm run tauri:build` (needs crates.io, and on
  Linux `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`);
- code under `#[cfg(target_os = "macos")]` or `"windows"` (the keychain, macOS
  `RunEvent::Opened`): the check runs for the Linux target only;
- `./gradlew assembleDebug` in `android/` (Android SDK + Google Maven);
- the Swift files and the widget/intents targets: Xcode on a Mac
  (see [Android and iOS builds](/self-hosting/mobile/)).

## When it fails

Each failure names the file and line, as `rustc` and `javac` print them. A
failure in step 2 that names a tauri item the stubs do not have
(`no method named … found`) means either a real bug or a missing stub: look
the item up in the tauri source for the version in `Cargo.lock` before
changing either side.
