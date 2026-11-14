// The interface language and direction, set before the first paint (plan
// W4.10): the saved choice; else Hebrew if the system lists it at all
// (W4.35); else the first supported language of the system
// (navigator.languages); else English. The page itself is written
// lang="he" dir="rtl" (Hebrew first, and right without JavaScript). A classic, render-blocking same-origin script: the page CSP
// allows no inline script. Mirrors detectLocale() in src/i18n/detect.ts
// (src/__tests__/hebrewFirstLoad.test.ts runs both on the same inputs).
(function () {
  var SUPPORTED = { en: "ltr", he: "rtl", ar: "rtl", ru: "ltr", fr: "ltr", de: "ltr", ja: "ltr", "zh-CN": "ltr" };
  function pick(saved, languages) {
    if (saved && Object.prototype.hasOwnProperty.call(SUPPORTED, saved)) return saved;
    // Plan W4.35: Hebrew anywhere in the system's list wins.
    for (var h = 0; h < (languages || []).length; h++) {
      if (/^(he|iw)(-|$)/i.test(String(languages[h] || ""))) return "he";
    }
    for (var i = 0; i < (languages || []).length; i++) {
      var tag = String(languages[i] || "").toLowerCase();
      var base = tag.split("-")[0];
      if (base === "iw") base = "he"; // the old code for Hebrew
      if (base === "zh") {
        // Simplified Chinese only (zh-CN, zh-Hans, zh-SG, plain zh).
        if (!/-(tw|hk|mo|hant)\b/.test(tag)) return "zh-CN";
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(SUPPORTED, base)) return base;
    }
    return "en";
  }
  var saved = null;
  try {
    var raw = localStorage.getItem("lumen-md");
    var s = raw ? JSON.parse(raw) : null;
    saved = s && s.state && s.state.locale;
  } catch (e) {
    /* storage unavailable or corrupt */
  }
  var langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
  var locale = pick(saved, langs);
  var el = document.documentElement;
  el.lang = locale;
  el.dir = SUPPORTED[locale];
  // Read by initLocale(), so the app starts in the same language without a flip.
  window.__lumenBootLocale = locale;
  window.__lumenPickLocale = pick;
})();
