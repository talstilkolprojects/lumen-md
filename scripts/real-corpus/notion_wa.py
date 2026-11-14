"""W6.38: Notion exports (Markdown & CSV, and HTML) of the 30 source documents,
and 30 WhatsApp chat exports, all written for this corpus (CC0 1.0), in the
shapes Notion and WhatsApp write."""
import json, os, random, sys, zipfile, html, urllib.parse, uuid
E = lambda s: html.escape(s, quote=True)
Q = lambda s: urllib.parse.quote(s)

def nid(r): return uuid.UUID(int=r.getrandbits(128)).hex

def md_runs(rs):
  o = ""
  for x in rs:
    t = x["text"]
    if x.get("bold") and t.strip(): t = f"**{t.strip()}**" + (" " if t.endswith(" ") else "")
    if x.get("italic") and t.strip(): t = f"*{t.strip()}*" + (" " if t.endswith(" ") else "")
    if x.get("href"): t = f"[{t}]({x['href']})"
    o += t
  return o

def notion_md(doc, r, folder, imgs):
  out = []
  for b in doc["blocks"]:
    if b["t"] == "h": out.append("#" * b["level"] + " " + b["text"])
    elif b["t"] == "p": out.append(md_runs(b["runs"]))
    elif b["t"] in ("ul", "ol"):
      lines = []
      for k, it in enumerate(b["items"]):
        lines.append(("- " if b["t"] == "ul" else f"{k+1}. ") + it["text"])
        for j, c in enumerate(it.get("children", [])): lines.append("    " + ("- " if b["t"] == "ul" else f"{j+1}. ") + c["text"])
      out.append("\n".join(lines))
    elif b["t"] == "table":
      rows = b["rows"]; out.append("\n".join(["| " + " | ".join(rows[0]) + " |", "| " + " | ".join("---" for _ in rows[0]) + " |"] + ["| " + " | ".join(x) + " |" for x in rows[1:]]))
    elif b["t"] == "img":
      imgs.append(b["src"]); out.append(f"![{b['src']}]({Q(folder)}/{Q(b['src'])})")
  return "\n\n".join(out) + "\n"

def notion_html_page(doc, r, folder, imgs):
  bid = lambda: str(uuid.UUID(int=r.getrandbits(128)))
  def runs(rs):
    o = ""
    for x in rs:
      t = E(x["text"])
      if x.get("bold"): t = f"<strong>{t}</strong>"
      if x.get("italic"): t = f"<em>{t}</em>"
      if x.get("href"): t = f'<a href="{E(x["href"])}">{t}</a>'
      o += t
    return o
  body = ""
  for b in doc["blocks"][1:]:
    if b["t"] == "h": body += f'<h{b["level"]} id="{bid()}" class="">{E(b["text"])}</h{b["level"]}>'
    elif b["t"] == "p": body += f'<p id="{bid()}" class="">{runs(b["runs"])}</p>'
    elif b["t"] in ("ul", "ol"):
      for k, it in enumerate(b["items"]):  # Notion writes one list element per item
        kids = ""
        if it.get("children"):
          if b["t"] == "ul": kids = "".join(f'<ul id="{bid()}" class="bulleted-list"><li style="list-style-type:circle">{E(c["text"])}</li></ul>' for c in it["children"])
          else: kids = "".join(f'<ol type="a" id="{bid()}" class="numbered-list" start="{j+1}"><li>{E(c["text"])}</li></ol>' for j, c in enumerate(it["children"]))
        if b["t"] == "ul": body += f'<ul id="{bid()}" class="bulleted-list"><li style="list-style-type:disc">{E(it["text"])}{kids}</li></ul>'
        else: body += f'<ol type="1" id="{bid()}" class="numbered-list" start="{k+1}"><li>{E(it["text"])}{kids}</li></ol>'
    elif b["t"] == "table":
      body += f'<table id="{bid()}" class="simple-table"><tbody>' + "".join(f'<tr id="{bid()}">' + "".join(f'<td id="{bid()[:4]}" class="">{E(c)}</td>' for c in row) + "</tr>" for row in b["rows"]) + "</tbody></table>"
    elif b["t"] == "img":
      imgs.append(b["src"]); src = f"{Q(folder)}/{Q(b['src'])}"
      body += f'<figure id="{bid()}" class="image"><a href="{src}"><img style="width:160px" src="{src}"/></a></figure>'
  title = E(doc["blocks"][0]["text"])
  return (f'<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"/><title>{title}</title><style>/* cspell:disable-file */ html {{ -webkit-print-color-adjust: exact; }}</style></head>'
          f'<body><article id="{bid()}" class="page sans"><header><h1 class="page-title">{title}</h1><p class="page-description"></p></header><div class="page-body">{body}</div></article><span class="sans" style="font-size:14px;padding-top:2em"></span></body></html>')

def notion(model, out, imgsrc):
  os.makedirs(out, exist_ok=True)
  for i, doc in enumerate(model):
    r = random.Random(500 + i); title = doc["blocks"][0]["text"].replace("/", "-").replace(":", "")
    pid = nid(r); folder = f"{title} {pid}"; imgs = []
    as_html = i % 2 == 1
    files = {}
    if as_html:
      files[f"{title} {pid}.html"] = notion_html_page(doc, r, folder, imgs)
    else:
      md = f"# {doc['blocks'][0]['text']}\n\n" + notion_md({**doc, "blocks": doc["blocks"][1:]}, r, folder, imgs)
      sub = "הערות נוספות"; sid = nid(r); db = "משימות"; did = nid(r)
      md += f"\n[{sub}]({Q(folder)}/{Q(sub)}%20{sid}.md)\n\n[{db}]({Q(folder)}/{Q(db)}%20{did}.csv)\n"
      files[f"{title} {pid}.md"] = md
      files[f"{folder}/{sub} {sid}.md"] = f"# {sub}\n\nחזרה ל[{doc['blocks'][0]['text']}](../{Q(title)}%20{pid}.md).\n"
      rows = [["Name", "Status", "Due", "Tags"], ["לשלוח את הדוח", "Done", "November 12, 2026", "עבודה, דחוף"], ["לקנות חלב", "Not started", "November 14, 2026", "בית"], ["Review PR", "In progress", "", "dev"]]
      csv = "﻿" + "\n".join(",".join('"' + c.replace('"', '""') + '"' if ("," in c or '"' in c) else c for c in row) for row in rows) + "\n"
      files[f"{folder}/{db} {did}.csv"] = csv
      files[f"{folder}/{db} {did}_all.csv"] = csv
      files[f"{folder}/{db} {did}/לשלוח את הדוח {nid(r)}.md"] = "# לשלוח את הדוח\n\nStatus: Done\nDue: November 12, 2026\nTags: עבודה, דחוף\n\nלצרף את הנספח.\n"
    for im in imgs: files[f"{folder}/{im}"] = open(f"{imgsrc}/{im}", "rb").read()
    with zipfile.ZipFile(f"{out}/notion-{doc['id']}-{'html' if as_html else 'md'}.zip", "w", zipfile.ZIP_DEFLATED) as z:
      for name, data in files.items():
        zi = zipfile.ZipInfo(name, (2026, 11, 12, 10, 0, 0)); zi.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(zi, data if isinstance(data, bytes) else data.encode("utf-8"))

# ── WhatsApp ────────────────────────────────────────────────────────────
NAMES_HE = ["טל", "נועה", "אבי כהן", "‏מיכל‏", "Dana", "יוסי"]
NAMES_AR = ["سارة", "أحمد", "ليلى"]
LINES = ["בוקר טוב! מה המצב?", "מגיע ב-8 בערב, לשמור לי מקום 🙏", "שלחתי לך את הקובץ במייל", "ok, see you at 9", "איפה נפגשים?\nליד הכניסה הראשית", "מזל טוב!!! 🎉🎂",
  "הנה הקישור: https://example.com/event?id=42", "תזכורת: אסיפת הורים ביום ד׳", "lol 😂", "אפשר לקנות 2 ליטר חלב ו-12 ביצים?", "כן, בדיוק כמו בפעם הקודמת (רק בלי בצל)", "שבת שלום ❤️"]
LINES_AR = ["صباح الخير", "سأصل الساعة ٨", "شكراً جزيلاً!"]
def wa(out):
  os.makedirs(out, exist_ok=True); man = []
  variants = ["android-he", "android-en12", "ios-he", "ios-en", "android-he12", "ios-ar", "android-ar-digits", "android-en24-slash", "ios-he-12", "android-de"]
  for i in range(30):
    r = random.Random(900 + i); v = variants[i % len(variants)]
    names = NAMES_AR[:2] if "ar" in v else r.sample(NAMES_HE, 2); lines = LINES_AR if "ar" in v else LINES
    msgs = []; t = 8 * 60 + r.randint(0, 120); day = r.randint(1, 28); mon = r.choice([1, 3, 7, 11, 12])
    for k in range(r.randint(6, 14)):
      t += r.randint(1, 50); hh, mm = divmod(t % (24 * 60), 60)
      kind = r.random()
      if kind < 0.1: msgs.append({"kind": "attach", "author": r.choice(names), "hh": hh, "mm": mm, "file": f"IMG-2026{mon:02d}{day:02d}-WA00{k:02d}.jpg"})
      elif kind < 0.15: msgs.append({"kind": "omitted", "author": r.choice(names), "hh": hh, "mm": mm})
      else: msgs.append({"kind": "text", "author": r.choice(names), "hh": hh, "mm": mm, "text": r.choice(lines)})
    def date(fmt):
      return {"dmy.": f"{day:02d}.{mon:02d}.2026", "mdy/": f"{mon}/{day}/26", "dmy/": f"{day:02d}/{mon:02d}/2026", "ymd-": f"2026-{mon:02d}-{day:02d}"}[fmt]
    def clock(hh, mm, twelve, he=False, ar=False, sec=False):
      s = f":{(hh*7+mm) % 60:02d}" if sec else ""
      if not twelve: return f"{hh:02d}:{mm:02d}{s}"
      h12 = hh % 12 or 12; ap = ("לפנה״צ" if hh < 12 else "אחה״צ") if he else (("ص" if hh < 12 else "م") if ar else ("AM" if hh < 12 else "PM"))
      return f"{h12}:{mm:02d}{s} {ap}" if not he and not ar else f"{h12}:{mm:02d}{s} {ap}"
    lines_out = []; ios = v.startswith("ios")
    fmt = {"android-he": "dmy.", "android-en12": "mdy/", "ios-he": "dmy.", "ios-en": "dmy/", "android-he12": "dmy.", "ios-ar": "dmy/", "android-ar-digits": "dmy/", "android-en24-slash": "dmy/", "ios-he-12": "dmy.", "android-de": "dmy."}[v]
    twelve = v in ("android-en12", "android-he12", "ios-he-12", "ios-ar")
    he = "he" in v; ar = "ar" in v
    sysmsg = {"he": "ההודעות והשיחות מוצפנות מקצה לקצה. לאף אחד מחוץ לצ'אט הזה, גם לא ל-WhatsApp, אין אפשרות לקרוא אותן או להאזין להן.", "en": "Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.", "ar": "الرسائل والمكالمات مشفرة تمامًا بين الطرفين.", "de": "Nachrichten und Anrufe sind Ende-zu-Ende-verschlüsselt."}["he" if he else "ar" if ar else "de" if v.endswith("de") else "en"]
    first = msgs[0]
    if ios: lines_out.append(f"[{date(fmt)}, {clock(first['hh'], first['mm'], twelve, he, ar, True)}] {names[0]}: ‎{sysmsg}")
    else: lines_out.append(f"{date(fmt)}, {clock(first['hh'], first['mm'], twelve, he, ar)} - {sysmsg}")
    for m in msgs:
      ts = clock(m["hh"], m["mm"], twelve, he, ar, ios); a = m["author"]
      if m["kind"] == "text": body = m["text"]
      elif m["kind"] == "attach":
        body = (f"‎<מצורף: {m['file']}>" if he else f"‎<attached: {m['file']}>") if ios else (f"{m['file']} (קובץ מצורף)" if he else f"{m['file']} (file attached)")
      else: body = ("‎התמונה הושמטה" if he else "‎image omitted") if ios else ("<המדיה לא נכללה>" if he else "<Media omitted>")
      d = date(fmt)
      if ios: line = (("‎" if m["kind"] != "text" else "") + f"[{d}, {ts}] {a}: {body}")
      else: line = f"{d}, {ts} - {a}: {body}"
      if v == "android-ar-digits": line = line.translate(str.maketrans("0123456789", "٠١٢٣٤٥٦٧٨٩"))
      lines_out.append(line)
    name = "_chat.txt" if ios else f"WhatsApp Chat with {names[1]}.txt"
    fn = f"wa{i+1:02d}-{v}-{name}"
    open(f"{out}/{fn}", "w", encoding="utf-8").write(("\r\n" if v == "android-de" else "\n").join(lines_out) + "\n")
    man.append({"file": fn, "variant": v, "messages": [{"kind": m["kind"], "author": m["author"], "hh": m["hh"], "mm": m["mm"], "y": 2026, "m": mon, "d": day, **({"text": m["text"]} if m["kind"] == "text" else {}), **({"file": m["file"]} if m["kind"] == "attach" else {})} for m in msgs]})
  json.dump(man, open(f"{out}/expected.json", "w"), ensure_ascii=False, indent=1)

if __name__ == "__main__":
  model = json.load(open(sys.argv[1])); out = sys.argv[2]
  notion(model, f"{out}/notion", f"{out}/src"); wa(f"{out}/whatsapp")
