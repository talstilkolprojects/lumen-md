const input = document.getElementById("url");
const target = document.getElementById("target");
const ok = document.getElementById("ok");
chrome.storage.local.get({ lumenUrl: "http://localhost:5173", target: "web" }).then((v) => {
  input.value = v.lumenUrl;
  target.value = v.target;
});
document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ lumenUrl: input.value.trim(), target: target.value });
  ok.classList.add("show");
  setTimeout(() => ok.classList.remove("show"), 1200);
});
