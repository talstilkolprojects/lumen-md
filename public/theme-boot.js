// Apply the saved theme before the boot shell paints (C1). A classic,
// render-blocking same-origin script: the page CSP allows no inline script.
// Mirrors applyTheme() in src/store/useStore.ts — "dark" (the default),
// "light", or "system" (the OS preference); App re-applies it on start.
(function () {
  var theme = "dark";
  try {
    var raw = localStorage.getItem("lumen-md");
    var saved = raw ? JSON.parse(raw) : null;
    var t = saved && saved.state && saved.state.theme;
    if (t === "light" || t === "dark" || t === "system") theme = t;
  } catch (e) {
    /* storage unavailable or corrupt: keep the default */
  }
  var dark = theme === "dark";
  if (theme === "system") {
    try {
      dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch (e) {
      dark = true;
    }
  }
  document.documentElement.classList.toggle("dark", dark);
})();
