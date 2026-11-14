// The beta page's script (plan W2.25): language toggle and the optional
// e-mail seam. A separate file because the site's CSP allows scripts from
// 'self' only (no inline script). It makes no request unless the owner set
// data-signup-endpoint AND the person ticked consent AND pressed the button;
// that endpoint's origin must then be added to connect-src (launch/README.md).
(function () {
  "use strict";
  var STR = {
    en: {
      langToggle: "עברית",
      title: "A note editor built for Hebrew",
      lead: "Lumen is a local, open-source Markdown editor: your notes stay with you, Hebrew behaves as it should, and every note is a plain file you can take anywhere.",
      p1t: "Hebrew first", p1: "A Hebrew interface, direction per line, search that understands prefixes and niqqud.",
      p2t: "Local and private", p2: "Notes stay on your device. No account, and it works offline.",
      p3t: "Your files", p3: "Every note is a Markdown file. Export everything in one click.",
      betaTitle: "What the beta is",
      beta1: "An early version, with new features before everyone else. We're looking for people who write in Hebrew — students, researchers, writers and developers — to use Lumen a few times a week and tell us what works and what doesn't.",
      beta2: "It's a beta: expect rough edges, and keep a backup.",
      beta3: "Feedback goes to GitHub Discussions, in the open, where anyone can read and reply.",
      beta4: "Once a week there's a short, voluntary survey. It is the only way we know who uses Lumen: the app doesn't count you.",
      joinTitle: "Join",
      join1: "Open a discussion in the beta category on GitHub. Fill in a short form (username, device, what you write in today), and that's it. You need a GitHub account.",
      joinBtn: "Join on GitHub Discussions",
      join2: "The link opens GitHub; this page sends nothing.",
      email1: "No GitHub? Leave an e-mail address and we'll tell you when there's a new beta. Only the address is sent, and only after you tick the box.",
      emailLabel: "E-mail address",
      consent: "I agree that my address is kept to receive beta news, and that I can ask for it to be deleted at any time.",
      emailBtn: "Keep me posted",
      sent: "Thanks — you're on the list.",
      failed: "That didn't go through. Try again later, or join on GitHub.",
      invalid: "That doesn't look like an e-mail address.",
      tryTitle: "Want to try it first?",
      tryBtn: "Open Lumen in the browser",
      compare: "How Lumen compares with Obsidian, Notion and Google Docs — with a source for every claim",
      community: "Community guide and code of conduct",
      docTitle: "Lumen — the Hebrew beta",
    },
  };
  var he = {};
  document.querySelectorAll("[data-i18n]").forEach(function (el) { he[el.getAttribute("data-i18n")] = el.textContent; });
  he.sent = "תודה — נרשמתם.";
  he.failed = "זה לא עבר. נסו שוב מאוחר יותר, או הצטרפו ב-GitHub.";
  he.invalid = "זו לא נראית כמו כתובת מייל.";
  he.emailLabel = "כתובת מייל";
  he.docTitle = document.title;
  STR.he = he;

  function stored(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (e) { /* storage blocked: nothing kept */ }
    return null;
  }
  // Hebrew unless asked for English (#en, or the toggle earlier).
  var lang = location.hash === "#en" || stored("lumen-beta-lang") === "en" ? "en" : "he";

  function apply(l) {
    lang = l;
    var s = STR[l];
    document.documentElement.lang = l;
    document.documentElement.dir = l === "he" ? "rtl" : "ltr";
    document.title = s.docTitle;
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var k = el.getAttribute("data-i18n");
      if (s[k]) el.textContent = s[k];
    });
    document.querySelectorAll("[data-i18n-aria]").forEach(function (el) {
      var k = el.getAttribute("data-i18n-aria");
      if (s[k]) el.setAttribute("aria-label", s[k]);
    });
    stored("lumen-beta-lang", l);
  }
  apply(lang);
  document.getElementById("lang-toggle").addEventListener("click", function () { apply(lang === "he" ? "en" : "he"); });

  // Joining is the person's own click to GitHub; remember only that it happened, here.
  document.getElementById("join-github").addEventListener("click", function () { stored("lumen-beta-join-opened", new Date().toISOString().slice(0, 10)); });

  // The optional e-mail list: hidden unless the owner configured an endpoint.
  var endpoint = (document.body.getAttribute("data-signup-endpoint") || "").trim();
  if (!/^https:\/\//.test(endpoint)) return;
  var box = document.getElementById("email-signup");
  var form = document.getElementById("email-form");
  var email = document.getElementById("email");
  var consent = document.getElementById("consent");
  var submit = document.getElementById("email-submit");
  var status = document.getElementById("email-status");
  box.hidden = false;
  consent.addEventListener("change", function () { submit.disabled = !consent.checked; });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!consent.checked) return;
    var v = email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { status.textContent = STR[lang].invalid; return; }
    submit.disabled = true;
    fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: v, consent: true, lang: lang }), credentials: "omit", referrerPolicy: "no-referrer" })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); status.textContent = STR[lang].sent; form.reset(); })
      .catch(function () { status.textContent = STR[lang].failed; submit.disabled = !consent.checked; });
  });
})();
