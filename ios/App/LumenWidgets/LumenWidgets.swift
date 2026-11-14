// The home-screen widget (plan W3.4): search, a quick note, today's note.
// A WidgetKit extension target ("LumenWidgets"); see the docs page
// editor/widgets for the Xcode steps. Each button is a link into the app
// (lumen://…); the widget shows no note content, so it needs no shared data.
// Layout follows the system: in Hebrew the row runs right to left.

import SwiftUI
import WidgetKit

struct LumenEntry: TimelineEntry {
    let date: Date
}

struct LumenProvider: TimelineProvider {
    func placeholder(in context: Context) -> LumenEntry { LumenEntry(date: Date()) }
    func getSnapshot(in context: Context, completion: @escaping (LumenEntry) -> Void) { completion(LumenEntry(date: Date())) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<LumenEntry>) -> Void) {
        // Static buttons: one entry, never refreshed.
        completion(Timeline(entries: [LumenEntry(date: Date())], policy: .never))
    }
}

struct ActionButton: View {
    let title: LocalizedStringKey
    let symbol: String
    let url: String

    var body: some View {
        Link(destination: URL(string: url)!) {
            VStack(spacing: 6) {
                Image(systemName: symbol).font(.title2)
                Text(title).font(.caption).lineLimit(1).minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .accessibilityLabel(Text(title))
    }
}

struct LumenWidgetView: View {
    var entry: LumenEntry
    @Environment(\.widgetFamily) var family

    var body: some View {
        let row = HStack(spacing: 8) {
            ActionButton(title: "widget.search", symbol: "magnifyingglass", url: "lumen://search")
            ActionButton(title: "widget.quickNote", symbol: "square.and.pencil", url: "lumen://capture")
            ActionButton(title: "widget.daily", symbol: "calendar", url: "lumen://daily")
        }
        if #available(iOS 17.0, *) {
            row.containerBackground(.fill.tertiary, for: .widget)
        } else {
            row.padding()
        }
    }
}

@main
struct LumenWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "LumenWidget", provider: LumenProvider()) { entry in
            LumenWidgetView(entry: entry)
        }
        .configurationDisplayName("widget.name")
        .description("widget.description")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
