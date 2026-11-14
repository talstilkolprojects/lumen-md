/**
 * Plan W2.25: the comparison's rules and its page, shared by
 * scripts/launch-check.mjs and its tests.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Problems with comparison.json. `docExists(slug)` checks a Lumen docs page. */
export function compareProblems(data, { docExists = () => true, strict = false } = {}) {
  const out = [];
  const products = data.products ?? [];
  const topics = (data.topics ?? []).map((t) => t.id);
  const seen = new Set();
  for (const c of data.claims ?? []) {
    const where = `${c.product}/${c.topic}`;
    if (!products.includes(c.product)) out.push(`${where}: unknown product`);
    if (!topics.includes(c.topic)) out.push(`${where}: unknown topic`);
    if (seen.has(where)) out.push(`${where}: listed twice`);
    seen.add(where);
    if (!c.en?.trim() || !c.he?.trim()) out.push(`${where}: needs the claim in English and Hebrew`);
    if (!c.source?.trim()) out.push(`${where}: no source`);
    for (const s of String(c.source ?? "").split(" · ")) {
      if (s.startsWith("/")) {
        if (!docExists(s)) out.push(`${where}: docs page ${s} does not exist`);
      } else if (!/^https:\/\/[^\s]+$/.test(s)) out.push(`${where}: source must be an https URL or a docs path (${s})`);
    }
    if (c.verified !== null && !DATE.test(String(c.verified))) out.push(`${where}: verified must be a date (YYYY-MM-DD) or null`);
    if (strict && !c.verified) out.push(`${where}: not verified yet`);
    // Plain, checkable wording.
    if (/\b(best|fastest|most powerful|world'?s)\b/i.test(c.en)) out.push(`${where}: superlatives can't be checked`);
  }
  for (const p of products) for (const t of topics) if (!seen.has(`${p}/${t}`)) out.push(`${p}/${t}: no claim`);
  for (const g of data.lumenGaps ?? []) {
    if (!g.en?.trim() || !g.he?.trim()) out.push("a gap needs English and Hebrew");
    if (!g.source || (g.source.startsWith("/") && !docExists(g.source))) out.push(`gap "${g.en}": bad source`);
  }
  if ((data.lumenGaps ?? []).length < 3) out.push("say at least three things Lumen lacks");
  return out;
}

const T = {
  en: {
    title: "Lumen, Obsidian, Notion and Google Docs",
    description: "An honest comparison for people who write in Hebrew: what each one does, with a source for every claim, and what Lumen still lacks.",
    intro: "Each one is good at something. This page says what each does on five points that matter when you write in Hebrew, and every claim links to where it can be checked. Claims about the other products come from their own pages.",
    topic: "Topic",
    sources: "Sources",
    unverified: "not yet verified",
    unverifiedNote: "A claim marked *not yet verified* has a source that hasn't been checked yet. It is checked before the launch.",
    gaps: "What Lumen still lacks",
    checked: "Checked",
    how: "This page is generated from `launch/comparison.json` by `node scripts/launch-check.mjs --write`. To correct a claim, change the JSON with a source, and the page follows.",
    docs: "Lumen docs",
  },
  he: {
    title: "Lumen, ‏Obsidian, ‏Notion ו-Google Docs",
    description: "השוואה כנה למי שכותב בעברית: מה כל אחד עושה, עם מקור לכל טענה, ומה עדיין חסר ב-Lumen.",
    intro: "כל אחד מהם טוב במשהו. הדף הזה מתאר מה כל אחד עושה בחמש נקודות שחשובות למי שכותב בעברית, וכל טענה מקושרת למקום שבו אפשר לבדוק אותה. טענות על המוצרים האחרים לקוחות מהדפים שלהם.",
    topic: "נושא",
    sources: "מקורות",
    unverified: "עוד לא נבדק",
    unverifiedNote: "לטענה שמסומנת *עוד לא נבדק* יש מקור שעוד לא נבדק. היא נבדקת לפני ההשקה.",
    gaps: "מה עדיין חסר ב-Lumen",
    checked: "נבדק",
    how: "הדף נוצר מ-`launch/comparison.json` באמצעות `node scripts/launch-check.mjs --write`. כדי לתקן טענה, משנים את ה-JSON עם מקור, והדף מתעדכן.",
    docs: "התיעוד של Lumen",
  },
};

const link = (s, lang) => (s.startsWith("/") ? `[${T[lang].docs}](${lang === "he" ? "/he" : ""}${s})` : `<${s}>`);

/** The comparison page in one language (Markdown with front matter). */
export function renderCompare(data, lang) {
  const t = T[lang];
  const name = (p) => data.names[p][lang];
  const L = ["---", `title: ${t.title}`, `description: ${t.description}`, "---", "", t.intro, ""];
  const anyUnverified = data.claims.some((c) => !c.verified);
  for (const topic of data.topics) {
    L.push(`## ${topic[lang]}`, "", `| | ${lang === "he" ? "מה הוא עושה" : "What it does"} | ${t.sources} |`, "|---|---|---|");
    for (const p of data.products) {
      const c = data.claims.find((x) => x.product === p && x.topic === topic.id);
      if (!c) continue;
      const mark = c.verified ? `${t.checked} ${c.verified}` : `⚠ ${t.unverified}`;
      L.push(`| **${name(p)}** | ${c[lang]} | ${c.source.split(" · ").map((s) => link(s, lang)).join(" · ")} (${mark}) |`);
    }
    L.push("");
  }
  L.push(`## ${t.gaps}`, "");
  for (const g of data.lumenGaps) L.push(`- ${g[lang]} (${link(g.source, lang)})`);
  L.push("");
  if (anyUnverified) L.push(`> ${t.unverifiedNote}`, "");
  L.push(t.how, "");
  return L.join("\n");
}
