// Siri, Spotlight and the Shortcuts app (plan W3.4): App Intents.
//
// - "Add to inbox" runs without opening Lumen: the text is queued
//   (PendingCaptures) and added to inbox.md the next time the app starts or
//   comes to the front, with the time it was said.
// - The others open the app on an action link (lumen://…), which the WebView
//   handles like a widget tap.
//
// App Shortcuts (below) put them in Spotlight and Siri with no setup, in
// English and Hebrew (AppShortcuts.strings in en.lproj / he.lproj).

import AppIntents
import Foundation

@available(iOS 16.0, *)
struct AddToInboxIntent: AppIntent {
    static var title: LocalizedStringResource = "Add to Lumen inbox"
    static var description = IntentDescription("Adds text to the end of inbox.md in Lumen.")
    static var openAppWhenRun = false

    @Parameter(title: "Text", requestValueDialog: "What should I add?")
    var text: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        PendingCaptures.add(text)
        return .result(dialog: "Added to your Lumen inbox.")
    }
}

@available(iOS 16.0, *)
struct QuickNoteIntent: AppIntent {
    static var title: LocalizedStringResource = "Quick note in Lumen"
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        LumenLaunch.deliver(URL(string: "lumen://capture")!)
        return .result()
    }
}

@available(iOS 16.0, *)
struct VoiceNoteIntent: AppIntent {
    static var title: LocalizedStringResource = "Voice note in Lumen"
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        LumenLaunch.deliver(URL(string: "lumen://capture?mode=voice")!)
        return .result()
    }
}

@available(iOS 16.0, *)
struct SearchNotesIntent: AppIntent {
    static var title: LocalizedStringResource = "Search Lumen"
    static var openAppWhenRun = true

    @Parameter(title: "Search for")
    var query: String?

    @MainActor
    func perform() async throws -> some IntentResult {
        var c = URLComponents(string: "lumen://search")!
        if let q = query, !q.isEmpty { c.queryItems = [URLQueryItem(name: "q", value: q)] }
        LumenLaunch.deliver(c.url!)
        return .result()
    }
}

@available(iOS 16.0, *)
struct DailyNoteIntent: AppIntent {
    static var title: LocalizedStringResource = "Today's note in Lumen"
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        LumenLaunch.deliver(URL(string: "lumen://daily")!)
        return .result()
    }
}

@available(iOS 16.0, *)
struct LumenShortcuts: AppShortcutsProvider {
    // Every phrase must contain the app name (Apple's rule).
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: AddToInboxIntent(), phrases: ["Add to \(.applicationName) inbox", "Add to my \(.applicationName) inbox"], shortTitle: "Add to inbox", systemImageName: "tray.and.arrow.down")
        AppShortcut(intent: QuickNoteIntent(), phrases: ["Quick note in \(.applicationName)", "New \(.applicationName) note"], shortTitle: "Quick note", systemImageName: "square.and.pencil")
        AppShortcut(intent: VoiceNoteIntent(), phrases: ["Voice note in \(.applicationName)"], shortTitle: "Voice note", systemImageName: "mic")
        AppShortcut(intent: SearchNotesIntent(), phrases: ["Search \(.applicationName)"], shortTitle: "Search", systemImageName: "magnifyingglass")
        AppShortcut(intent: DailyNoteIntent(), phrases: ["Today's \(.applicationName) note", "Open today in \(.applicationName)"], shortTitle: "Today's note", systemImageName: "calendar")
    }
}
