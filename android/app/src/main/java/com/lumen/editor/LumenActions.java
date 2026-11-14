package com.lumen.editor;

/**
 * Widgets and App Shortcuts (plan W3.4): the action links the native side
 * hands to the WebView (src/mobile/nativeActions.ts decides what they mean).
 * Plain Java, no Android types, so it is compiled and tested without the SDK.
 */
public final class LumenActions {
    private LumenActions() {}

    public static final String SCHEME = "lumen";
    public static final String SEARCH = "lumen://search";
    public static final String CAPTURE = "lumen://capture";
    public static final String VOICE = "lumen://capture?mode=voice";
    public static final String DAILY = "lumen://daily";
    public static final String NEW_NOTE = "lumen://new";

    /** Is this a link the WebView handles? Only lumen://, nothing else is forwarded. */
    public static boolean isAction(String url) {
        if (url == null || url.length() > 16 * 1024) return false;
        return url.startsWith("lumen://") || url.startsWith("lumen:");
    }

    /**
     * Add the time the app received the link ({@code t}, ms since epoch), so
     * the WebView can log arrival → cursor. An existing {@code t} is replaced.
     */
    public static String stamped(String url, long nowMs) {
        if (!isAction(url)) return url;
        int hash = url.indexOf('#');
        String frag = hash >= 0 ? url.substring(hash) : "";
        String base = hash >= 0 ? url.substring(0, hash) : url;
        int q = base.indexOf('?');
        StringBuilder out = new StringBuilder(q >= 0 ? base.substring(0, q) : base);
        String sep = "?";
        if (q >= 0) {
            for (String part : base.substring(q + 1).split("&")) {
                if (part.isEmpty() || part.equals("t") || part.startsWith("t=")) continue;
                out.append(sep).append(part);
                sep = "&";
            }
        }
        out.append(sep).append("t=").append(nowMs);
        return out.append(frag).toString();
    }
}
