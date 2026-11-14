/**
 * Lumen Web Clipper v2 — service worker (plan 4.15.2).
 *
 * Delivery, in order: an open Lumen tab (the bridge content script hands the
 * clip over with postMessage); else a new Lumen tab, then the bridge; on the
 * desktop app, the deep link lumen://clip. Nothing is POSTed anywhere: the
 * old /api/clip endpoint never existed.
 */
const DEFAULT_LUMEN_URL = "http://localhost:5173";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "lumen-clip", title: "Clip to Lumen", contexts: ["selection", "page"] });
  chrome.contextMenus.create({ id: "lumen-highlight", title: "Lumen highlighter on/off", contexts: ["page", "selection"] });
});

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["contentScript.js"] });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  await inject(tab.id);
  if (info.menuItemId === "lumen-clip") chrome.tabs.sendMessage(tab.id, { type: "lumen-clip-page" });
  if (info.menuItemId === "lumen-highlight") chrome.tabs.sendMessage(tab.id, { type: "lumen-highlight-mode" });
});

const waitComplete = (tabId) =>
  new Promise((resolve) => {
    const l = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(l);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(l);
  });

async function deliver(payload) {
  const { lumenUrl, target } = await chrome.storage.local.get({ lumenUrl: DEFAULT_LUMEN_URL, target: "web" });
  if (target === "desktop") {
    // The desktop app registers lumen://; a very large page is sent without its HTML.
    const small = JSON.stringify(payload).length > 1_500_000 ? { ...payload, html: undefined } : payload;
    await chrome.tabs.create({ url: `lumen://clip?data=${encodeURIComponent(JSON.stringify(small))}`, active: false });
    return { ok: true };
  }
  const origin = new URL(lumenUrl).origin;
  let [tab] = await chrome.tabs.query({ url: `${origin}/*` });
  if (!tab) {
    tab = await chrome.tabs.create({ url: lumenUrl });
    await waitComplete(tab.id);
  }
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["bridge.js"] });
  const resp = await chrome.tabs.sendMessage(tab.id, { type: "lumen-bridge-deliver", payload });
  await chrome.tabs.update(tab.id, { active: true });
  return resp ?? { ok: false };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "lumen-clip") return;
  deliver(msg.payload).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});
