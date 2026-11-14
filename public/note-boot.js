// The last note, painted before the bundle loads (plan W2.21). A classic
// same-origin script right after the boot shell (the page CSP allows no
// inline script): it reads the note the app already keeps in localStorage
// ("lumen-md", the persisted store — no new copy is stored anywhere) and
// shows its beginning as plain text in the shell, so a cold start shows
// the user's own note at once instead of skeleton bars. React replaces the
// whole shell on its first render. Text only (textContent), never HTML.
(function () {
  var MAX_CHARS = 4000;
  var page = document.querySelector(".boot-shell .boot-page");
  if (!page) return;
  var text = "";
  var rtl = false;
  try {
    var raw = localStorage.getItem("lumen-md");
    var saved = raw ? JSON.parse(raw) : null;
    var s = saved && saved.state;
    if (s && s.doc && typeof s.doc.content === "string") text = s.doc.content;
    rtl = !!(s && s.rtl);
  } catch (e) {
    /* storage unavailable or corrupt: keep the skeleton */
    return;
  }
  if (!text.trim()) return;
  var note = document.createElement("pre");
  note.className = "boot-note";
  note.setAttribute("dir", rtl ? "rtl" : "auto");
  note.textContent = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  page.textContent = "";
  page.appendChild(note);
  // Read by e2e/cold-start.spec.ts: the shell showed the note before the app started.
  document.documentElement.setAttribute("data-boot-note", "");
})();
