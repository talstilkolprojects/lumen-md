"""Renderers for the W6.38 model: plain HTML (LibreOffice's input), the
Google Docs clipboard payload and the Word clipboard payload."""
import base64, html, io, json, os, random, sys, uuid
from PIL import Image, ImageDraw

def png(i):
  im = Image.new("RGB", (160, 90), (250, 250, 250)); d = ImageDraw.Draw(im)
  r = random.Random(i)
  for k in range(5):
    h = r.randint(10, 80); d.rectangle([10 + k * 30, 85 - h, 30 + k * 30, 85], fill=(60 + 30 * k, 90, 200 - 20 * k))
  b = io.BytesIO(); im.save(b, "PNG", optimize=True); return b.getvalue()

E = lambda s: html.escape(s, quote=True)
HEB = lambda s: any("\u0590" <= c <= "\u05ff" for c in s)

# ── plain HTML for LibreOffice ──────────────────────────────────────────
def plain(doc, imgs):
  d = doc["dir"]
  def runs(rs):
    o = ""
    for x in rs:
      t = E(x["text"])
      if x.get("bold"): t = f"<b>{t}</b>"
      if x.get("italic"): t = f"<i>{t}</i>"
      if x.get("href"): t = f'<a href="{E(x["href"])}">{t}</a>'
      o += t
    return o
  def lst(b):
    tag = b["t"]; o = f"<{tag}>"
    for it in b["items"]:
      o += f"<li>{E(it['text'])}"
      if it.get("children"): o += f"<{tag}>" + "".join(f"<li>{E(c['text'])}</li>" for c in it["children"]) + f"</{tag}>"
      o += "</li>"
    return o + f"</{tag}>"
  body = ""
  for b in doc["blocks"]:
    if b["t"] == "h": body += f"<h{b['level']}>{E(b['text'])}</h{b['level']}>\n"
    elif b["t"] == "p": body += f"<p>{runs(b['runs'])}</p>\n"
    elif b["t"] in ("ul", "ol"): body += lst(b) + "\n"
    elif b["t"] == "table":
      body += '<table border="1">' + "".join("<tr>" + "".join(f"<td>{E(c)}</td>" for c in row) + "</tr>" for row in b["rows"]) + "</table>\n"
    elif b["t"] == "img":
      body += f'<p><img src="data:image/png;base64,{base64.b64encode(imgs[b["src"]]).decode()}" alt="{E(b["alt"])}" width="160" height="90"></p>\n'
  return f'<!DOCTYPE html>\n<html lang="{"he" if d == "rtl" else "en"}" dir="{d}"><head><meta charset="utf-8"><title>{E(doc["blocks"][0]["text"])}</title></head><body dir="{d}">\n{body}</body></html>\n'

# ── Google Docs clipboard (text/html) ───────────────────────────────────
SPAN = "font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:{w};font-style:{s};font-variant:normal;text-decoration:{td};vertical-align:baseline;white-space:pre;white-space:pre-wrap;"
def gdocs(doc, seed):
  r = random.Random(seed); d = doc["dir"]; al = "right" if d == "rtl" else "left"; side = "right" if d == "rtl" else "left"
  guid = f"docs-internal-guid-{uuid.UUID(int=r.getrandbits(128))}"
  def span(t, w=400, s="normal", td="none", color=None, size=None):
    st = SPAN.format(w=w, s=s, td=td)
    if color: st = st.replace("color:#000000", f"color:{color}")
    if size: st = st.replace("font-size:11pt", f"font-size:{size}pt")
    return f'<span style="{st}">{E(t)}</span>'
  def runs(rs):
    o = ""
    for x in rs:
      if x.get("href"):
        o += f'<a href="{E(x["href"])}" style="text-decoration:none;">' + span(x["text"], td="underline", color="#1155cc").replace("text-decoration:underline;", "text-decoration:underline;-webkit-text-decoration-skip:none;text-decoration-skip-ink:none;") + "</a>"
      else: o += span(x["text"], 700 if x.get("bold") else 400, "italic" if x.get("italic") else "normal")
    return o
  P = lambda inner, extra="": f'<p dir="{d}" {extra}style="line-height:1.38;margin-{side}:0pt;text-align:{al};margin-top:0pt;margin-bottom:0pt;">{inner}</p>'
  out = ""
  for b in doc["blocks"]:
    if b["t"] == "h":
      lv = b["level"]; size = {1: 20, 2: 16, 3: 14}[lv]
      out += f'<h{lv} dir="{d}" style="line-height:1.38;margin-{side}:0pt;text-align:{al};margin-top:{24 - 4*lv}pt;margin-bottom:6pt;">{span(b["text"], size=size)}</h{lv}>'
    elif b["t"] == "p": out += P(runs(b["runs"])) + "<br>"
    elif b["t"] in ("ul", "ol"):
      tag = b["t"]; lst = "decimal" if tag == "ol" else "disc"; lst2 = "lower-alpha" if tag == "ol" else "circle"
      def li(text, level, ls):
        return f'<li dir="{d}" aria-level="{level}" style="list-style-type:{ls};font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;">' + P(span(text), 'role="presentation" ') + "</li>"
      out += f'<{tag} style="margin-top:0;margin-bottom:0;padding-inline-start:48px;">'
      for it in b["items"]:
        out += li(it["text"], 1, lst)
        if it.get("children"):  # Docs nests the sub-list as a sibling inside the parent list, not inside the <li>
          out += f'<{tag} style="margin-top:0;margin-bottom:0;padding-inline-start:48px;">' + "".join(li(c["text"], 2, lst2) for c in it["children"]) + f"</{tag}>"
      out += f"</{tag}><br>"
    elif b["t"] == "table":
      cols = len(b["rows"][0])
      out += f'<div dir="{d}" style="margin-{side}:0pt;" align="{al}"><table style="border:none;border-collapse:collapse;"><colgroup>' + "".join('<col width="200" />' for _ in range(cols)) + "</colgroup><tbody>"
      for row in b["rows"]:
        out += '<tr style="height:0pt">' + "".join('<td style="border-left:solid #000000 1pt;border-right:solid #000000 1pt;border-bottom:solid #000000 1pt;border-top:solid #000000 1pt;vertical-align:top;padding:5pt 5pt 5pt 5pt;overflow:hidden;overflow-wrap:break-word;">' + f'<p dir="{d}" style="line-height:1.2;text-align:{al};margin-top:0pt;margin-bottom:0pt;">{span(c)}</p></td>' for c in row) + "</tr>"
      out += "</tbody></table></div><br>"
    elif b["t"] == "img":
      key = "".join(r.choice("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") for _ in range(60))
      out += P(f'<span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;"><span style="border:none;display:inline-block;overflow:hidden;width:160px;height:90px;"><img src="https://lh7-rt.googleusercontent.com/docsz/AD_4nX{key}?key=k{key[:20]}" width="160" height="90" alt="{E(b["alt"])}" style="margin-left:0px;margin-top:0px;" /></span></span>') + "<br>"
  return f'<meta charset="utf-8"><b style="font-weight:normal;" id="{guid}">{out}</b>'

# ── Word clipboard (text/html, Word 2016+ on Windows) ───────────────────
def word(doc, seed):
  d = doc["dir"]; rtl = d == "rtl"; D = "RTL" if rtl else "LTR"
  pst = "text-align:right;direction:rtl;unicode-bidi:embed" if rtl else ""
  def sp(t):
    lang = "HE" if HEB(t) else "EN-US"
    return f"<span lang={lang} style='font-family:\"Arial\",sans-serif;mso-bidi-language:HE'>{E(t)}</span>" if lang == "HE" else f"<span lang=EN-US dir=LTR>{E(t)}</span>"
  def runs(rs):
    o = ""
    for x in rs:
      t = sp(x["text"])
      if x.get("bold"): t = f"<b>{t}</b>"
      if x.get("italic"): t = f"<i>{t}</i>"
      if x.get("href"): t = f'<a href="{E(x["href"])}">{t}</a>'
      o += t
    return o
  out = ""; lists = 0; img = 0
  for b in doc["blocks"]:
    if b["t"] == "h":
      out += f"<h{b['level']} dir={D}>{sp(b['text'])}<o:p></o:p></h{b['level']}>\n"
    elif b["t"] == "p":
      out += f"<p class=MsoNormal dir={D} style='{pst}'>{runs(b['runs'])}<o:p></o:p></p>\n"
    elif b["t"] in ("ul", "ol"):
      lists += 1; flat = []
      for it in b["items"]:
        flat.append((1, it["text"]))
        for c in it.get("children", []): flat.append((2, c["text"]))
      n1 = 0; n2 = 0
      for k, (lv, text) in enumerate(flat):
        cls = "MsoListParagraphCxSpFirst" if k == 0 else "MsoListParagraphCxSpLast" if k == len(flat) - 1 else "MsoListParagraphCxSpMiddle"
        if len(flat) == 1: cls = "MsoListParagraph"
        if b["t"] == "ul":
          glyph, font = ("·", "Symbol") if lv == 1 else ("o", "\"Courier New\"")
        else:
          if lv == 1: n1 += 1; n2 = 0; glyph = f"{n1}."
          else: n2 += 1; glyph = f"{'abcdefgh'[n2-1]}."
          font = "\"Arial\",sans-serif"
        margin = f"margin-top:0cm;margin-{'right' if rtl else 'left'}:{36*lv}.0pt;margin-bottom:0cm;margin-{'left' if rtl else 'right'}:0cm"
        out += (f"<p class={cls} dir={D} style='{margin};{'text-align:right;' if rtl else ''}text-indent:-18.0pt;mso-list:l{lists-1} level{lv} lfo{lists};{'direction:rtl;unicode-bidi:embed' if rtl else ''}'>"
                f"<![if !supportLists]><span style='font-family:{font};mso-fareast-font-family:{font};mso-bidi-font-family:{font}'><span style='mso-list:Ignore'>{E(glyph)}<span style='font:7.0pt \"Times New Roman\"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><![endif]>"
                f"<span dir={D}></span>{sp(text)}<o:p></o:p></p>\n")
    elif b["t"] == "table":
      out += f"<table class=MsoTableGrid dir={'rtl' if rtl else 'ltr'} border=1 cellspacing=0 cellpadding=0 style='border-collapse:collapse;border:none;mso-border-alt:solid windowtext .5pt;mso-yfti-tbllook:1184;{'mso-table-dir:bidi;' if rtl else ''}mso-padding-alt:0cm 5.4pt 0cm 5.4pt'>\n"
      for ri, row in enumerate(b["rows"]):
        out += f" <tr style='mso-yfti-irow:{ri}{';mso-yfti-firstrow:yes' if ri == 0 else ''}'>\n" + "".join(f"  <td width=200 valign=top style='width:150.0pt;border:solid windowtext 1.0pt;padding:0cm 5.4pt 0cm 5.4pt'><p class=MsoNormal dir={D} style='margin-bottom:0cm;line-height:normal;{pst}'>{sp(c)}<o:p></o:p></p></td>\n" for c in row) + " </tr>\n"
      out += "</table>\n<p class=MsoNormal><o:p>&nbsp;</o:p></p>\n"
    elif b["t"] == "img":
      img += 1
      src = f"file:///C:/Users/tal/AppData/Local/Temp/msohtmlclip1/01/clip_image{img:03d}.png"
      out += (f"<p class=MsoNormal dir={D} style='{pst}'><span lang=HE><!--[if gte vml 1]><v:shape id=\"Picture_x0020_{img}\" o:spid=\"_x0000_i102{img}\" type=\"#_x0000_t75\" alt=\"{E(b['alt'])}\" style='width:120pt;height:67.5pt;visibility:visible;mso-wrap-style:square'><v:imagedata src=\"{src}\" o:title=\"\"/></v:shape><![endif]--><![if !vml]>"
              f"<img width=160 height=90 src=\"{src}\" alt=\"{E(b['alt'])}\" v:shapes=\"Picture_x0020_{img}\"><![endif]></span><o:p></o:p></p>\n")
  head = ("<html xmlns:v=\"urn:schemas-microsoft-com:vml\" xmlns:o=\"urn:schemas-microsoft-com:office:office\" xmlns:w=\"urn:schemas-microsoft-com:office:word\" xmlns:m=\"http://schemas.microsoft.com/office/2004/12/omml\" xmlns=\"http://www.w3.org/TR/REC-html40\">\n"
          "<head><meta http-equiv=Content-Type content=\"text/html; charset=utf-8\"><meta name=ProgId content=Word.Document><meta name=Generator content=\"Microsoft Word 15\"><meta name=Originator content=\"Microsoft Word 15\">"
          "<link rel=File-List href=\"file:///C:/Users/tal/AppData/Local/Temp/msohtmlclip1/01/clip_filelist.xml\">"
          "<style><!-- /* Style Definitions */ p.MsoNormal, li.MsoNormal, div.MsoNormal {margin:0cm;margin-bottom:8.0pt;text-align:right;direction:rtl;unicode-bidi:embed;font-size:11.0pt;font-family:\"Calibri\",sans-serif;} @list l0:level1 {mso-level-number-format:bullet;mso-level-text:\\F0B7;} --></style></head>\n")
  return head + f"<body lang=EN-US style='tab-interval:36.0pt;word-wrap:break-word'>\n<!--StartFragment-->{out}<!--EndFragment-->\n</body>\n</html>\n"

if __name__ == "__main__":
  model = json.load(open(sys.argv[1])); out = sys.argv[2]
  imgs = {f"img{i}.png": png(i) for i in range(5)}
  for sub in ("src", "gdocs", "word"): os.makedirs(f"{out}/{sub}", exist_ok=True)
  for k, v in imgs.items(): open(f"{out}/src/{k}", "wb").write(v)
  for i, doc in enumerate(model):
    open(f"{out}/src/{doc['id']}.html", "w").write(plain(doc, imgs))
    open(f"{out}/gdocs/{doc['id']}.html", "w").write(gdocs(doc, 7000 + i))
    open(f"{out}/word/{doc['id']}.html", "w").write(word(doc, 8000 + i))
