// MV3 pages may not run inline scripts: the popup's code lives here.
async function send(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["contentScript.js"] });
  await chrome.tabs.sendMessage(tab.id, message);
  window.close();
}
document.getElementById("clip-page").addEventListener("click", () => send({ type: "lumen-clip-page" }));
document.getElementById("clip-selection").addEventListener("click", () => send({ type: "lumen-clip-page", selectionOnly: true }));
document.getElementById("highlight").addEventListener("click", () => send({ type: "lumen-highlight-mode" }));
