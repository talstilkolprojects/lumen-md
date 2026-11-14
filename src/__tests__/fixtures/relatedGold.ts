/**
 * Plan W2.2 gold set: 50 topics (25 English, 25 Hebrew), two notes each
 * written differently — they share a few topic words, often in another
 * form (Hebrew prefix letters, plural/singular, full/defective spelling) —
 * plus 40 distractor notes that use one topic word each among everyday
 * words. Each topic gives two pairs (A → B and B → A): 100 pairs.
 */
export interface GoldNote {
  path: string;
  text: string;
}

const EN: Array<[string, string[]]> = [
  ["sourdough", ["sourdough", "starter", "levain", "hydration", "crumb", "proofing"]],
  ["kubernetes", ["kubernetes", "cluster", "pods", "helm", "ingress", "autoscaling"]],
  ["marathon", ["marathon", "tempo", "mileage", "taper", "pacing", "splits"]],
  ["beekeeping", ["hive", "queen", "brood", "honeycomb", "smoker", "varroa"]],
  ["mortgage", ["mortgage", "refinance", "amortization", "escrow", "lender", "principal"]],
  ["guitar", ["guitar", "chords", "fretboard", "capo", "strumming", "arpeggio"]],
  ["composting", ["compost", "worms", "nitrogen", "carbon", "humus", "bokashi"]],
  ["photography", ["aperture", "shutter", "exposure", "lens", "bokeh", "iso"]],
  ["chess", ["chess", "opening", "gambit", "endgame", "castling", "pawn"]],
  ["sailing", ["sailing", "jib", "tacking", "keel", "mainsail", "leeward"]],
  ["vaccines", ["vaccine", "antibodies", "booster", "immunity", "antigen", "dose"]],
  ["espresso", ["espresso", "grinder", "crema", "portafilter", "tamping", "extraction"]],
  ["astronomy", ["telescope", "nebula", "galaxy", "eyepiece", "orbit", "comet"]],
  ["woodworking", ["chisel", "dovetail", "joinery", "plane", "lumber", "sanding"]],
  ["taxes", ["deduction", "taxable", "irs", "refund", "withholding", "audit"]],
  ["climbing", ["belay", "carabiner", "bouldering", "crimp", "rappel", "harness"]],
  ["podcasting", ["podcast", "microphone", "episode", "editing", "rss", "interview"]],
  ["genealogy", ["ancestors", "census", "lineage", "surname", "archives", "pedigree"]],
  ["aquarium", ["aquarium", "filter", "cichlids", "ammonia", "substrate", "tank"]],
  ["origami", ["origami", "crease", "fold", "crane", "paper", "tessellation"]],
  ["solar", ["solar", "panels", "inverter", "kilowatt", "battery", "rooftop"]],
  ["sql", ["sql", "query", "index", "join", "postgres", "schema"]],
  ["knitting", ["knitting", "yarn", "purl", "stitch", "needles", "skein"]],
  ["fermentation", ["kimchi", "brine", "lactobacillus", "jar", "ferment", "sauerkraut"]],
  ["birding", ["binoculars", "warbler", "migration", "plumage", "sighting", "heron"]],
];
const HE: Array<[string, string[]]> = [
  ["מחמצת", ["מחמצת", "בצק", "קמח", "תסיסה", "לחות", "אפייה"]],
  ["גינה", ["עגבניות", "שתילים", "השקיה", "דשן", "ערוגה", "קומפוסט"]],
  ["משכנתא", ["משכנתא", "ריבית", "בנק", "החזר", "הלוואה", "מסלול"]],
  ["ריצה", ["ריצה", "אימון", "קצב", "מרתון", "נעליים", "סיבולת"]],
  ["צילום", ["מצלמה", "צמצם", "חשיפה", "עדשה", "תאורה", "פריים"]],
  ["גיטרה", ["גיטרה", "אקורדים", "מיתרים", "פריטה", "סולם", "כיוון"]],
  ["דבורים", ["כוורת", "דבורים", "מלכה", "דבש", "חלות", "עקיצה"]],
  ["שחמט", ["שחמט", "פתיחה", "מלך", "רגלי", "הצרחה", "סיום"]],
  ["חיסונים", ["חיסון", "נוגדנים", "מנה", "חסינות", "דלקת", "מרפאה"]],
  ["אסטרונומיה", ["טלסקופ", "כוכבים", "גלקסיה", "ערפילית", "מסלול", "שביט"]],
  ["נגרות", ["נגרות", "עץ", "מסור", "שיוף", "דבק", "מגרעת"]],
  ["מסים", ["מס", "החזר", "ניכוי", "הכנסה", "דוח", "זיכוי"]],
  ["טיפוס", ["טיפוס", "חבל", "אבטחה", "קיר", "רתמה", "סלע"]],
  ["פודקאסט", ["פודקאסט", "מיקרופון", "פרק", "עריכה", "הקלטה", "ראיון"]],
  ["אקווריום", ["אקווריום", "דגים", "מסנן", "אמוניה", "מצע", "צמחייה"]],
  ["שמש", ["סולארי", "פאנלים", "ממיר", "קילוואט", "סוללה", "גג"]],
  ["סריגה", ["סריגה", "צמר", "מסרגות", "עין", "פקעת", "דוגמה"]],
  ["כבישה", ["כבישה", "מלפפונים", "מלח", "צנצנת", "חמוצים", "שום"]],
  ["ציפורים", ["משקפת", "ציפורים", "נדידה", "נוצות", "תצפית", "אנפה"]],
  ["יין", ["יין", "ענבים", "בציר", "חבית", "יקב", "טעימה"]],
  ["שיפוץ", ["שיפוץ", "קבלן", "אריחים", "צנרת", "חשמלאי", "הצעת"]],
  ["תזונה", ["חלבון", "פחמימות", "ויטמינים", "ירקות", "ארוחה", "קלוריות"]],
  ["טיול", ["מסלול", "תרמיל", "מעיין", "שמורה", "מפה", "קמפינג"]],
  ["יוגה", ["יוגה", "נשימה", "תנוחה", "מזרן", "גמישות", "מדיטציה"]],
  ["הורות", ["תינוק", "שינה", "הנקה", "גן", "חיתולים", "רופאה"]],
];
const FILLER_EN = ["today", "really", "think", "maybe", "week", "plan", "notes", "good", "later", "started", "again", "list"];
const FILLER_HE = ["היום", "ממש", "חושב", "אולי", "שבוע", "תוכנית", "רשימה", "טוב", "אחר", "התחלתי", "שוב", "דברים"];
/** A Hebrew prefix letter (or a plural ending in English) on some words, so the pair does not share exact forms only. */
const vary = (w: string, i: number, he: boolean) => (he ? ["ב", "ה", "ו", "ל", ""][i % 5] + w : i % 3 === 0 && !w.endsWith("s") ? `${w}s` : w);

export function goldVault(): { notes: GoldNote[]; pairs: Array<[string, string]> } {
  const notes: GoldNote[] = [];
  const pairs: Array<[string, string]> = [];
  const add = (topics: Array<[string, string[]]>, he: boolean) =>
    topics.forEach(([name, w], k) => {
      const filler = he ? FILLER_HE : FILLER_EN;
      const a = `${he ? "he" : "en"}/${name}-a.md`;
      const b = `${he ? "he" : "en"}/${name}-b.md`;
      const aText = `${filler[k % 12]} ${vary(w[0], k, he)} ${filler[(k + 1) % 12]} ${w[1]} ${w[2]} ${filler[(k + 2) % 12]} ${w[3]}.`;
      const bText = `${filler[(k + 3) % 12]} ${w[2]} ${vary(w[3], k + 1, he)} ${filler[(k + 4) % 12]} ${w[4]} ${w[5]} ${vary(w[0], k + 2, he)}.`;
      notes.push({ path: a, text: `# ${name} A\n\n${aText}\n` }, { path: b, text: `# ${name} B\n\n${bText}\n` });
      pairs.push([a, b], [b, a]);
    });
  add(EN, false);
  add(HE, true);
  // Distractors: everyday words plus one topic word from a topic.
  for (let i = 0; i < 40; i++) {
    const he = i % 2 === 1;
    const [, w] = (he ? HE : EN)[(i * 7) % 25];
    const filler = he ? FILLER_HE : FILLER_EN;
    notes.push({ path: `misc/d${i}.md`, text: `# ${he ? "יומן" : "Diary"} ${i}\n\n${filler.slice(i % 6, (i % 6) + 6).join(" ")} ${w[5]} ${filler[(i + 3) % 12]}.\n` });
  }
  return { notes, pairs };
}
