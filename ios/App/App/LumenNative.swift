// Widgets, Shortcuts and Siri (plan W3.4): the native half of the seam in
// src/mobile/nativeActions.ts. Everything that starts outside the app —
// a widget button, a Siri / Spotlight App Intent, a lumen:// link — ends here
// as an action link for the WebView, or as a queued capture.
//
// Nothing here decides what an action means; the WebView does (and tests it).

import Capacitor
import Foundation
import UIKit

/// Links that arrived before the WebView was ready, and the latest one.
enum LumenLaunch {
    static var pending: String?

    /// Stamp the time the app received the link (`t`, ms since epoch) so the
    /// WebView can log arrival → cursor (the widget's own tap time isn't knowable).
    static func stamped(_ url: URL) -> String {
        guard var c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url.absoluteString }
        var items = (c.queryItems ?? []).filter { $0.name != "t" }
        items.append(URLQueryItem(name: "t", value: String(Int64(Date().timeIntervalSince1970 * 1000))))
        c.queryItems = items
        return c.url?.absoluteString ?? url.absoluteString
    }

    /// Hand a link to the WebView: now if it listens, else on `getLaunchUrl`.
    static func deliver(_ url: URL) {
        guard url.scheme == "lumen" else { return }
        let s = stamped(url)
        pending = s
        NotificationCenter.default.post(name: .lumenAction, object: nil, userInfo: ["url": s])
    }
}

extension Notification.Name {
    static let lumenAction = Notification.Name("lumen:action")
}

/// Captures from "Add to inbox" (Siri / Shortcuts), kept until the WebView adds them.
/// App Intents defined in the app target run in the app's process, so the
/// app's own UserDefaults is enough (no App Group).
enum PendingCaptures {
    static let key = "lumen.pendingCaptures"
    static let maxItems = 200

    static func all(_ d: UserDefaults = .standard) -> [[String: String]] {
        d.array(forKey: key) as? [[String: String]] ?? []
    }

    static func add(_ text: String, _ d: UserDefaults = .standard) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        var items = all(d)
        let iso = ISO8601DateFormatter().string(from: Date())
        items.append(["id": UUID().uuidString, "text": String(trimmed.prefix(8192)), "at": iso])
        d.set(Array(items.suffix(maxItems)), forKey: key)
    }

    static func remove(_ ids: [String], _ d: UserDefaults = .standard) {
        let drop = Set(ids)
        d.set(all(d).filter { !drop.contains($0["id"] ?? "") }, forKey: key)
    }
}

/// The Capacitor plugin the WebView calls `LumenNative`.
@objc(LumenNativePlugin)
public class LumenNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LumenNativePlugin"
    public let jsName = "LumenNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getLaunchUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pendingCaptures", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeCaptures", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(onAction(_:)), name: .lumenAction, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(onResume), name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    @objc func onAction(_ n: Notification) {
        guard let url = n.userInfo?["url"] as? String else { return }
        LumenLaunch.pending = nil
        notifyListeners("url", data: ["url": url])
    }

    @objc func onResume() {
        notifyListeners("resume", data: [:])
    }

    @objc func getLaunchUrl(_ call: CAPPluginCall) {
        let url = LumenLaunch.pending
        LumenLaunch.pending = nil
        call.resolve(["url": url as Any])
    }

    @objc func pendingCaptures(_ call: CAPPluginCall) {
        call.resolve(["items": PendingCaptures.all()])
    }

    @objc func removeCaptures(_ call: CAPPluginCall) {
        PendingCaptures.remove(call.getArray("ids", String.self) ?? [])
        call.resolve()
    }
}

/// Registers the app's own plugin (Capacitor loads npm plugins by itself;
/// a plugin inside the app target is registered here). Main.storyboard
/// uses this class instead of CAPBridgeViewController.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(LumenNativePlugin())
    }
}
