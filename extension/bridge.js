/**
 * Lumen Web Clipper v2 — app side (plan 4.15.2). Runs only on the Lumen tab
 * (injected by background.js into the configured Lumen origin). An extension
 * cannot trigger a PWA share_target, so the clip is handed to the app with
 * window.postMessage on the app's own window, and the app acknowledges.
 */
(function () {
  if (window.__LUMEN_BRIDGE__) return;
  window.__LUMEN_BRIDGE__ = true;
  const TYPE = "lumen-clip-v2";
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "lumen-bridge-deliver") return;
    let tries = 0;
    const send = () => {
      // Wait until the app has started listening (it sets this flag).
      if (document.documentElement.dataset.lumenClipReady !== "1" && tries++ < 100) return void setTimeout(send, 100);
      const onAck = (e) => {
        if (e.source === window && e.data?.type === `${TYPE}:ack` && e.data.url === msg.payload.url) {
          window.removeEventListener("message", onAck);
          sendResponse({ ok: true });
        }
      };
      window.addEventListener("message", onAck);
      window.postMessage({ type: TYPE, payload: msg.payload }, location.origin);
    };
    send();
    return true;
  });
})();
