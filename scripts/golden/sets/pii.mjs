/**
 * ner-pii parts.
 *   iahltwiki — 100 sentences of the UD_Hebrew-IAHLTwiki test split with
 *               their nested IAHLT entities as character spans (80 with a
 *               PER entity, 20 without).
 *   synthetic — 150 sentences written for this set (templates below) and
 *               filled with Faker he names / cities / streets and generated
 *               numbers: 100 with PII, 50 hard negatives.
 */
import { rankKey, splitPool, splitPoolWith } from "../../lib/golden.mjs";
import { fetchText, rawUrl, sha256 } from "../fetch.mjs";
import { SRC } from "../defs.mjs";

// ── IAHLTwiki ───────────────────────────────────────────────────────────

/** Spans of the syntactic words inside one surface token (prefix and suffix alignment; elided letters get zero width). */
function wordSpans(surface, forms) {
  const spans = forms.map(() => null);
  let pos = 0;
  let i = 0;
  for (; i < forms.length; i++) {
    if (!surface.startsWith(forms[i], pos)) break;
    spans[i] = [pos, pos + forms[i].length];
    pos += forms[i].length;
  }
  let end = surface.length;
  for (let j = forms.length - 1; j >= i; j--) {
    if (end - forms[j].length >= pos && surface.slice(end - forms[j].length, end) === forms[j]) {
      spans[j] = [end - forms[j].length, end];
      end -= forms[j].length;
    } else break;
  }
  return spans.map((s) => s ?? [pos, pos]);
}

export function parseConllu(text) {
  const out = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split("\n").filter(Boolean);
    const sentId = lines.find((l) => l.startsWith("# sent_id = "))?.slice(12);
    const sent = lines.find((l) => l.startsWith("# text = "))?.slice(9);
    if (!sentId || sent === undefined) continue;
    const rows = lines.filter((l) => !l.startsWith("#")).map((l) => l.split("\t"));
    const words = new Map();
    const tokens = [];
    const inRange = new Set();
    for (const r of rows) {
      if (r[0].includes(".")) continue;
      if (r[0].includes("-")) {
        const [a, b] = r[0].split("-").map(Number);
        tokens.push({ form: r[1], words: Array.from({ length: b - a + 1 }, (_, k) => a + k) });
        for (let k = a; k <= b; k++) inRange.add(k);
      } else {
        const id = Number(r[0]);
        words.set(id, { form: r[1], misc: r[9] });
        if (!inRange.has(id)) tokens.push({ form: r[1], words: [id] });
      }
    }
    // Character span of every word.
    const span = new Map();
    let cursor = 0;
    let ok = true;
    for (const t of tokens) {
      const at = sent.indexOf(t.form, cursor);
      if (at < 0) {
        ok = false;
        break;
      }
      const inner = wordSpans(t.form, t.words.map((w) => words.get(w).form));
      t.words.forEach((w, k) => span.set(w, [at + inner[k][0], at + inner[k][1]]));
      cursor = at + t.form.length;
    }
    if (!ok) continue;
    // Nested entities from MISC Entity=(TYPE … TYPE) / (TYPE).
    const entities = [];
    const stack = [];
    for (const id of [...words.keys()].sort((a, b) => a - b)) {
      const ent = (words.get(id).misc ?? "").split("|").find((x) => x.startsWith("Entity="));
      if (!ent) continue;
      for (const m of ent.slice(7).matchAll(/\(([A-Z]+)\)|\(([A-Z]+)|([A-Z]+)\)/g)) {
        if (m[1]) entities.push({ type: m[1], from: id, to: id });
        else if (m[2]) stack.push({ type: m[2], from: id });
        else {
          const k = stack.map((s) => s.type).lastIndexOf(m[3]);
          if (k >= 0) entities.push({ ...stack.splice(k, 1)[0], to: id });
        }
      }
    }
    const spans = entities
      .map((e) => {
        const start = span.get(e.from)[0];
        const end = span.get(e.to)[1];
        return { start, end, type: e.type, text: sent.slice(start, end) };
      })
      .filter((e) => e.end > e.start && e.text.trim() === e.text)
      .sort((a, b) => a.start - b.start || b.end - a.end);
    out.push({ sentId, text: sent, entities: spans, parsed: entities.length === spans.length });
  }
  return out;
}

export const iahlt = {
  pool(ctx) {
    const s = SRC.iahltwiki;
    const path = "he_iahltwiki-ud-test.conllu";
    const text = fetchText(ctx.cache, rawUrl(s.repo, s.commit, path), { name: "iahltwiki-test.conllu" });
    const items = parseConllu(text)
      .filter((x) => x.parsed)
      .map((x) => ({ id: `iahlt-${x.sentId.replace(/^iahltwiki_/, "")}`, sentId: x.sentId, text: x.text, entities: x.entities }));
    return { items, provenance: { repo: `https://github.com/${s.repo}`, commit: s.commit, files: { [path]: sha256(text) } } };
  },
  /** 80% of each split has a PER entity, 20% has none. */
  select(pool, opts) {
    const per = pool.items.filter((x) => x.entities.some((e) => e.type === "PER"));
    const none = pool.items.filter((x) => !x.entities.some((e) => e.type === "PER"));
    const a = splitPool(per, { ...opts, part: `${opts.part}:per`, nDev: Math.round(opts.nDev * 0.8), nTest: Math.round(opts.nTest * 0.8) });
    const b = splitPool(none, { ...opts, part: `${opts.part}:none`, nDev: opts.nDev - Math.round(opts.nDev * 0.8), nTest: opts.nTest - Math.round(opts.nTest * 0.8) });
    const byId = (x, y) => (x.id < y.id ? -1 : 1);
    return { dev: [...a.dev, ...b.dev].sort(byId), test: [...a.test, ...b.test].sort(byId) };
  },
  meta: (pool) => ({
    source: { ...pool.provenance, sampling: "pool: every test sentence whose entities all map to characters; 80% drawn from sentences with a PER entity, 20% from those without (splitPool per stratum)" },
    fields: { text: "the sentence (# text)", entities: "[{start, end, type, text}] — UTF-16 offsets; nested IAHLT types: PER, GPE, LOC, FAC, ORG, TIMEX, TTL, EVE, WOA, DUC, ANG, MISC" },
    piiMapping: { PER: "PERSON", GPE: "LOCATION", LOC: "LOCATION", FAC: "LOCATION", TIMEX: "DATE (not PII unless a birth date)" },
  }),
};

// ── Synthetic PII ───────────────────────────────────────────────────────

/** String literals of a Faker locale source file (export default [...] or { key: [...] }), parsed as data. */
export function fakerStrings(source, key) {
  let body = source;
  if (key) {
    const at = source.search(new RegExp(`\\b${key}\\s*:\\s*\\[`));
    if (at < 0) return [];
    body = source.slice(at, source.indexOf("]", at));
  }
  return [...body.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map((m) => (m[1] ?? m[2]).replace(/\\(.)/g, "$1")).filter((x) => !x.includes("{{"));
}

/** Israeli ID (ת״ז): 8 digits + check digit (weights 1,2,1,2…, digits of products summed). */
export function idCheckDigit(first8) {
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    let v = Number(first8[i]) * (i % 2 === 0 ? 1 : 2);
    if (v > 9) v -= 9;
    sum += v;
  }
  return String((10 - (sum % 10)) % 10);
}
export const validIsraeliId = (id) => /^\d{9}$/.test(id) && idCheckDigit(id.slice(0, 8)) === id[8];

export function luhnDigit(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let v = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) {
      v *= 2;
      if (v > 9) v -= 9;
    }
    sum += v;
  }
  return String((10 - (sum % 10)) % 10);
}
export const luhnValid = (n) => {
  const d = n.replace(/\D/g, "");
  return d.length >= 12 && luhnDigit(d.slice(0, -1)) === d.at(-1);
};

/** Israeli IBAN: IL + 2 check digits + 3-digit bank + 3-digit branch + 13-digit account (ISO 13616 mod 97). */
export function ibanIL(bban) {
  const rearranged = `${bban}1821` + "00"; // I=18, L=21
  let rem = 0;
  for (const ch of rearranged) rem = (rem * 10 + Number(ch)) % 97;
  return `IL${String(98 - rem).padStart(2, "0")}${bban}`;
}
export function ibanValid(iban) {
  const s = iban.replace(/\s/g, "");
  const r = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of r) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

/** A deterministic number stream from a seed. */
function digits(seed, n) {
  let out = "";
  let k = 0;
  while (out.length < n) out += BigInt(`0x${rankKey(seed, String(k++))}`).toString().slice(1);
  return out.slice(0, n);
}

/**
 * Templates written for this set, with the grammatical gender of {first} /
 * {name} (m, f, or n = either). {name} {first} {last} {city} {street} {num}
 * are filled from Faker he; {phone} {mobile} {email} {id} {card} {iban}
 * {dob} {plate} are generated. Each slot becomes a span with its PII type.
 */
const POSITIVE = [
  ["n", "שלום {name}, הפגישה נקבעה ליום שלישי. אפשר לחזור אליי ב-{mobile}."],
  ["m", "{name} ביקש לעדכן את כתובת המייל שלו ל-{email}."],
  ["n", "מספר תעודת הזהות של {name} הוא {id}, יש לצרף צילום."],
  ["n", "לתשלום: כרטיס {card}, על שם {name}."],
  ["f", "את ההחזר יש להעביר לחשבון {iban} של {name}, היא אישרה את הפרטים."],
  ["m", "{name} גר ברחוב {street} {num}, {city}."],
  ["f", "תאריך הלידה של {first} הוא {dob}, ולכן היא זכאית להנחה."],
  ["n", "המשלוח יגיע לרחוב {street} {num} ב{city}; איש קשר: {name}, {mobile}."],
  ["n", "רשמתי את {name} (ת״ז {id}) לחוג שמתחיל בחודש הבא."],
  ["n", "נא לשלוח את החשבונית ל-{email} ולא לכתובת הישנה."],
  ["n", "הטלפון בבית של משפחת {last} הוא {phone}."],
  ["m", "סיכום שיחה עם {name}: מבקש שנחזור אליו עד מחר, נייד {mobile}."],
  ["n", "פרטי ההעברה: {iban}, הבנק אישר את הפרטים."],
  ["m", "הרכב של {first}, מספר רישוי {plate}, חונה מול הבניין."],
  ["n", "בטופס: שם — {name}; ת״ז — {id}; תאריך לידה — {dob}."],
  ["f", "{first} שלחה לי את מספר הכרטיס {card} כדי לשלם על הכרטיסים להופעה."],
  ["n", "הכתובת למשלוח דואר: {street} {num}, {city}, לידי {name}."],
  ["m", "אם {first} לא עונה, אפשר לנסות את {mobile} או לכתוב ל-{email}."],
  ["f", "ביום ההולדת של {first} ({dob}) נעשה לה מסיבה קטנה."],
  ["f", "דיברתי היום עם {name} מ{city} על השיפוץ בדירה שלה."],
];

const NEGATIVE = [
  "מספר ההזמנה שלך הוא {order}; שמור אותו לבירורים.",
  "מספר המעקב של החבילה הוא {tracking} ואפשר לבדוק אותו באתר הדואר.",
  "בטופס הופיע המספר {badid}, אבל ספרת הביקורת שלו שגויה ולכן אינו מספר זהות.",
  "{hist} הוא תאריך שכל תלמיד בישראל לומד בשיעורי היסטוריה.",
  "הקוד של המוצר במחסן הוא {sku}, והמלאי יתעדכן בסוף השבוע.",
  "המספר {badcard} נדחה: הוא לא עובר את בדיקת Luhn.",
  "הכנס נערך ב-{event}, ואלפי משתתפים הגיעו.",
  "בחשבונית מספר {invoice} הסכום הכולל הוא 1,250 ש״ח.",
  "קו האוטובוס {bus} יוצא מהתחנה המרכזית כל עשרים דקות.",
  "מספר הדגם {model} מופיע על המדבקה בגב המכשיר.",
];

/** Historical and public dates: not anyone's birth date. */
const HISTORICAL = ["14 במאי 1948", "29 בנובמבר 1947", "11 באפריל 1909", "5 ביוני 1967", "6 באוקטובר 1973", "20 ביולי 1969", "9 בנובמבר 1989", "4 בנובמבר 1995", "17 בספטמבר 1978", "26 באוקטובר 1994", "2 בנובמבר 1917", "8 במאי 1945"];
const EVENTS = ["3 עד 5 בספטמבר 2019", "12.3.2023", "1–2 בפברואר 2024", "18 ביוני 2022", "7.11.2021", "20 עד 22 במרץ 2018", "15.5.2025", "28–30 באוגוסט 2023"];

const SLOT_TYPE = { name: "PERSON", first: "PERSON", last: "PERSON", city: "LOCATION", street: "ADDRESS", num: "ADDRESS", phone: "PHONE", mobile: "PHONE", email: "EMAIL", id: "IL_ID", card: "CREDIT_CARD", iban: "IBAN", dob: "DATE_OF_BIRTH", plate: "LICENSE_PLATE" };
const NEG_KIND = { order: "order-number", tracking: "tracking-number", badid: "invalid-il-id", sku: "product-code", badcard: "luhn-invalid", invoice: "invoice-number", bus: "bus-line", hist: "historical-date", event: "event-date", model: "model-number" };

/** The Faker he lists the generator draws from (data parsed from the source files; no Faker code runs). */
export function loadFakerLists(cache) {
  const s = SRC.faker;
  const files = {};
  const read = (path) => {
    const t = fetchText(cache, rawUrl(s.repo, s.commit, path), { name: `faker-${path.replace(/\W+/g, "_")}` });
    files[path] = sha256(t);
    return t;
  };
  const firstSrc = read("src/locales/he/person/first_name.ts");
  const heb = (x) => /^[\u05D0-\u05EA' ]+$/.test(x);
  const lists = {
    first: { f: fakerStrings(firstSrc, "female").filter(heb), m: fakerStrings(firstSrc, "male").filter(heb), n: fakerStrings(firstSrc, "generic").filter(heb) },
    last: fakerStrings(read("src/locales/he/person/last_name.ts"), "generic").filter((x) => /^[\u05D0-\u05EA'\- ]+$/.test(x)),
    cities: fakerStrings(read("src/locales/he/location/city_name.ts")).filter((x) => /^[\u05D0-\u05EA'\- ]+$/.test(x) && !x.includes("(")),
    streets: fakerStrings(read("src/locales/he/location/street_name_part.ts")).filter((x) => /^[\u05D0-\u05EA'\- "]+$/.test(x)),
  };
  if (lists.first.f.length < 30 || lists.first.m.length < 30 || lists.first.n.length < 30 || lists.last.length < 50 || lists.cities.length < 50 || lists.streets.length < 50) throw new Error("Faker he lists are shorter than expected");
  return { lists, provenance: { repo: `https://github.com/${s.repo}`, commit: s.commit, tag: s.tag, files } };
}

/**
 * One generated sentence for `slot` (an id such as "pos-0042"): the
 * template, names and numbers all come from sha256(seed, slot, …), so the
 * same seed and slot always give the same item. Pure: tests pass fixture lists.
 */
export function makePii(lists, slot, seed) {
  const negative = slot.startsWith("neg-");
  const key = slot;
  const pickFrom = (list, k) => list[parseInt(rankKey(seed, `${key}:${k}`).slice(0, 8), 16) % list.length];
  const tIndex = parseInt(rankKey(seed, `${key}:template`).slice(0, 8), 16) % (negative ? NEGATIVE.length : POSITIVE.length);
  const [gender, template] = negative ? ["n", NEGATIVE[tIndex]] : POSITIVE[tIndex];
  const f = pickFrom(lists.first[gender], "first");
  const l = pickFrom(lists.last, "last");
  const d = (k, len) => digits(`${seed}:${key}:${k}`, len);
  const { cities, streets } = lists;
    const values = {
      first: f,
      last: l,
      name: `${f} ${l}`,
      city: pickFrom(cities, "city"),
      street: pickFrom(streets, "street"),
      num: String(1 + (parseInt(d("num", 3), 10) % 120)),
      phone: `0${["2", "3", "4", "8", "9"][Number(d("area", 1)) % 5]}-${d("phone", 7)}`,
      mobile: `05${["0", "2", "3", "4", "8"][Number(d("pre", 1)) % 5]}-${d("mobile", 7)}`,
      email: `${["noa", "dani", "yael", "omer", "tamar", "itai", "shira", "amit"][Number(d("user", 1)) % 8]}.${d("emailnum", 3)}@example.${["com", "org", "net"][Number(d("tld", 1)) % 3]}`,
      id: (() => {
        const b = d("id", 8);
        return b + idCheckDigit(b);
      })(),
      card: (() => {
        const b = `4580${d("card", 11)}`;
        return `${b}${luhnDigit(b)}`.replace(/(\d{4})(?=\d)/g, "$1 ");
      })(),
      iban: ibanIL(`0${["10", "11", "12", "20", "31"][Number(d("bank", 1)) % 5]}${d("branch", 3)}${d("acct", 13)}`).replace(/(.{4})(?=.)/g, "$1 "),
      dob: `${1 + (parseInt(d("day", 2), 10) % 28)}.${1 + (parseInt(d("mon", 2), 10) % 12)}.${1950 + (parseInt(d("year", 2), 10) % 55)}`,
      plate: `${d("plate", 3)}-${d("plate2", 2)}-${d("plate3", 3)}`,
      // 9 digits, but never a valid ת״ז: the context alone must not decide.
      order: (() => {
        const b = d("order", 8);
        return b + String((Number(idCheckDigit(b)) + 5) % 10);
      })(),
      tracking: `RR${d("trk", 9)}IL`,
      badid: (() => {
        const b = d("badid", 8);
        return b + String((Number(idCheckDigit(b)) + 1 + (Number(d("off", 1)) % 8)) % 10);
      })(),
      sku: `${d("sku1", 3)}-${d("sku2", 7)}`,
      badcard: (() => {
        const b = `4580${d("bcard", 11)}`;
        return `${b}${(Number(luhnDigit(b)) + 3) % 10}`.replace(/(\d{4})(?=\d)/g, "$1 ");
      })(),
      invoice: `${2024 + (Number(d("inv", 1)) % 3)}-${d("inv2", 5)}`,
      bus: String(1 + (parseInt(d("bus", 3), 10) % 480)),
      hist: pickFrom(HISTORICAL, "hist"),
      event: pickFrom(EVENTS, "event"),
      model: `${["SM", "KX", "TV", "HB"][Number(d("model", 1)) % 4]}-${d("model2", 6)}`,
    };
    let text = "";
    const entities = [];
    const negatives = [];
    let at = 0;
    for (const m of template.matchAll(/\{(\w+)\}/g)) {
      text += template.slice(at, m.index);
      const v = values[m[1]];
      if (v === undefined) throw new Error(`unknown slot ${m[1]}`);
      const span = { start: text.length, end: text.length + v.length, text: v };
      if (SLOT_TYPE[m[1]] && !negative) entities.push({ ...span, type: SLOT_TYPE[m[1]] });
      else if (NEG_KIND[m[1]]) negatives.push({ ...span, kind: NEG_KIND[m[1]] });
      text += v;
      at = m.index + m[0].length;
    }
    text += template.slice(at);
    // Street + number are one address; keep them as one ADDRESS span when adjacent.
    const merged = [];
    for (const e of entities) {
      const prev = merged.at(-1);
      if (prev && prev.type === "ADDRESS" && e.type === "ADDRESS" && text.slice(prev.end, e.start) === " ") {
        prev.end = e.end;
        prev.text = text.slice(prev.start, prev.end);
      } else merged.push({ ...e });
    }
    const item = { id: `pii-${slot}`, kind: negative ? "hard-negative" : "positive", template: `${negative ? "n" : "p"}${tIndex + 1}`, text, entities: merged, negatives };
  checkPii(item);
  return item;
}

/** Every span matches its text; every ID / card / IBAN is valid, every negative look-alike is not. */
export function checkPii(it) {
  for (const e of it.entities) {
    if (it.text.slice(e.start, e.end) !== e.text) throw new Error(`bad span in ${it.id}`);
    if (e.type === "IL_ID" && !validIsraeliId(e.text)) throw new Error(`invalid id in ${it.id}`);
    if (e.type === "CREDIT_CARD" && !luhnValid(e.text)) throw new Error(`invalid card in ${it.id}`);
    if (e.type === "IBAN" && !ibanValid(e.text)) throw new Error(`invalid IBAN in ${it.id}`);
  }
  for (const g of it.negatives) {
    if (it.text.slice(g.start, g.end) !== g.text) throw new Error(`bad negative span in ${it.id}`);
    if (/^\d{9}$/.test(g.text) && validIsraeliId(g.text)) throw new Error(`negative ${g.kind} passes the ת״ז check in ${it.id}`);
    if (g.kind === "luhn-invalid" && luhnValid(g.text)) throw new Error(`negative card is valid in ${it.id}`);
  }
}

const slots = (prefix, n) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${String(i).padStart(4, "0")}` }));

export const synthetic = {
  pool(ctx) {
    return { ...loadFakerLists(ctx.cache), items: [...slots("pos", 2000), ...slots("neg", 1000)] };
  },
  /** Two thirds positive, one third hard negatives in each split. */
  select(pool, opts) {
    // No sentence twice, within a split or across dev and test.
    const seen = new Set();
    const make = (slot, seed) => {
      const it = makePii(pool.lists, slot.id, seed);
      if (seen.has(it.text)) return null;
      seen.add(it.text);
      return it;
    };
    const nPos = (n) => Math.round((n * 2) / 3);
    const a = splitPoolWith(pool.items.filter((x) => x.id.startsWith("pos-")), { ...opts, part: `${opts.part}:pos`, nDev: nPos(opts.nDev), nTest: nPos(opts.nTest) }, make);
    const b = splitPoolWith(pool.items.filter((x) => x.id.startsWith("neg-")), { ...opts, part: `${opts.part}:neg`, nDev: opts.nDev - nPos(opts.nDev), nTest: opts.nTest - nPos(opts.nTest) }, make);
    const byId = (x, y) => (x.id < y.id ? -1 : 1);
    return { dev: [...a.dev, ...b.dev].sort(byId), test: [...a.test, ...b.test].sort(byId) };
  },
  meta: (pool) => ({
    source: { ...pool.provenance, sampling: `${POSITIVE.length} positive and ${NEGATIVE.length} negative templates written for this set; for each slot the split's seed picks the template, the Faker he name, city and street, and every digit (makePii)` },
    fields: {
      text: "the sentence",
      entities: "[{start, end, type, text}] — UTF-16 offsets; types: PERSON, PHONE, EMAIL, IL_ID (valid check digit), CREDIT_CARD (Luhn-valid, test prefix 4580), IBAN (valid IL mod-97), ADDRESS, LOCATION, DATE_OF_BIRTH, LICENSE_PLATE",
      negatives: "look-alikes that must NOT be redacted: [{start, end, kind, text}]",
      kind: "positive | hard-negative",
      template: "which template (p1…, n1…)",
    },
    note: "All values are generated; emails use example.com/org/net (RFC 2606). A generated ID or card number may coincide with a real one by chance; it is not anyone's data.",
  }),
};
