/**
 * Small EPUB books for tests (plan W1.14): EPUB 3 with a nav document, or
 * EPUB 2 with an NCX; Hebrew (RTL) or English; a stylesheet with an
 * embedded font and an image, a remote image and a script that must never
 * survive, and a link between chapters.
 */
import { writeZip } from "./zipWriter";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const FONT = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4]);

export interface FixtureOpts {
  version?: 2 | 3;
  hebrew?: boolean;
  deflate?: boolean;
}

export async function makeEpub(o: FixtureOpts = {}): Promise<Uint8Array> {
  const he = o.hebrew ?? false;
  const v3 = (o.version ?? 3) === 3;
  const lang = he ? "he" : "en";
  const ch = he
    ? [
        ["פרק ראשון", "בראשית היה הדבר. זהו משפט ראשון בספר."],
        ["פרק שני", "המשפט השני נמצא בפרק השני של הספר."],
      ]
    : [
        ["Chapter One", "In the beginning was the word. This is the first sentence."],
        ["Chapter Two", "The second sentence lives in the second chapter."],
      ];
  const chapter = (i: number) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}" lang="${lang}"${he ? ' dir="rtl"' : ""}>
<head><title>${ch[i][0]}</title><link rel="stylesheet" href="../css/book.css"/><link rel="stylesheet" href="https://cdn.example.com/x.css"/><script>window.__epubScript = 1</script></head>
<body><h1 id="top">${ch[i][0]}</h1><p onclick="window.__epubClick = 1">${ch[i][1]}</p>
<p><img src="../img/dot.png" alt="dot"/><img src="https://example.com/track.png" alt="remote"/></p>
<p><a href="${i === 0 ? "ch2.xhtml#top" : "ch1.xhtml"}">${i === 0 ? "next" : "back"}</a> <a href="https://example.com/">out</a></p></body></html>`;
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${v3 ? "3.0" : "2.0"}" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:test</dc:identifier><dc:title>${he ? "ספר בדיקה" : "Test Book"}</dc:title><dc:creator>${he ? "פלוני" : "Ada"}</dc:creator><dc:language>${lang}</dc:language></metadata>
<manifest>
${v3 ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' : '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'}
<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
<item id="css" href="css/book.css" media-type="text/css"/>
<item id="font" href="fonts/f.woff2" media-type="font/woff2"/>
<item id="img" href="img/dot.png" media-type="image/png"/>
</manifest>
<spine${v3 ? "" : ' toc="ncx"'}${he ? ' page-progression-direction="rtl"' : ""}><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`;
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
<nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">${ch[0][0]}</a><ol><li><a href="text/ch1.xhtml#top">${ch[0][0]} · 1</a></li></ol></li><li><a href="text/ch2.xhtml">${ch[1][0]}</a></li></ol></nav>
</body></html>`;
  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
<navPoint id="p1"><navLabel><text>${ch[0][0]}</text></navLabel><content src="text/ch1.xhtml"/></navPoint>
<navPoint id="p2"><navLabel><text>${ch[1][0]}</text></navLabel><content src="text/ch2.xhtml"/></navPoint>
</navMap></ncx>`;
  const css = `@import url("https://cdn.example.com/a.css");
@font-face { font-family: Book; src: url("../fonts/f.woff2") format("woff2"); }
body { font-family: Book, serif; background: url(https://example.com/bg.png); }
p { margin: 0 0 1em; }`;
  return writeZip(
    [
      ["mimetype", "application/epub+zip"],
      ["META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`],
      ["OEBPS/content.opf", opf],
      [v3 ? "OEBPS/nav.xhtml" : "OEBPS/toc.ncx", v3 ? nav : ncx],
      ["OEBPS/text/ch1.xhtml", chapter(0)],
      ["OEBPS/text/ch2.xhtml", chapter(1)],
      ["OEBPS/css/book.css", css],
      ["OEBPS/fonts/f.woff2", FONT],
      ["OEBPS/img/dot.png", PNG],
    ],
    { deflate: o.deflate },
  );
}
