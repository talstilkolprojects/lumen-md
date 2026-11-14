/**
 * Scan highlights from a printed page (plan W7.2): a photo (the phone's
 * camera or a dropped image) → highlighter and underline marks (./detect) →
 * OCR of only those lines (src/ai/ocr, on this device) → highlights in the
 * book's note of the highlights hub (W1.15), with the page number.
 *
 * Nothing goes over the network. The photo is kept only when the box is
 * ticked; otherwise it lives in memory until the dialog closes.
 */
import { useEffect, useRef, useState } from "react";
import { getLocale, t } from "../../i18n";
import "./strings";
import { detectMarks, padBox, type Box, type Mark } from "./detect";
import { cleanIsbn, groupPassages, pageNumberOf, scannedBook, type ScannedMark } from "./text";
import { writeBooks } from "../import/runImport";
import { bookNotePath, safeName } from "../import/notes";
import { showAiToast } from "../../ui/AiToast";
import { explainError } from "../../lib/userError";
import { useFocusTrap } from "../../ui/useFocusTrap";

/** Detection runs on a copy this wide; OCR reads the full-size photo. */
const DETECT_WIDTH = 1400;

interface Props {
  onClose: () => void;
}

interface Read {
  marks: Mark[];
  passages: ScannedMark[];
  page: number | null;
  scale: number;
}

async function loadCanvas(file: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file);
  const c = document.createElement("canvas");
  c.width = bitmap.width;
  c.height = bitmap.height;
  c.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return c;
}

function scaled(src: HTMLCanvasElement, width: number): { canvas: HTMLCanvasElement; scale: number } {
  const scale = Math.min(1, width / src.width);
  const c = document.createElement("canvas");
  c.width = Math.round(src.width * scale);
  c.height = Math.round(src.height * scale);
  c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
  return { canvas: c, scale };
}

const up = (b: Box, s: number): Box => ({ x0: Math.round(b.x0 / s), y0: Math.round(b.y0 / s), x1: Math.round(b.x1 / s), y1: Math.round(b.y1 / s) });

/** The whole pipeline on one photo: marks, OCR of the marks and of the header and footer strips, passages, page. */
export async function readPage(file: Blob, rtl: boolean): Promise<Read & { full: HTMLCanvasElement }> {
  const full = await loadCanvas(file);
  const { canvas, scale } = scaled(full, DETECT_WIDTH);
  const px = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
  const marks = detectMarks(px, { rtl });
  const { ocrBoxes } = await import("../../ai/ocr");
  const boxes = marks.map((m) => up(padBox(m.box, canvas), scale));
  const strip = Math.round(full.height * 0.08);
  const strips: Box[] = [
    { x0: 0, y0: 0, x1: full.width - 1, y1: strip },
    { x0: 0, y0: full.height - 1 - strip, x1: full.width - 1, y1: full.height - 1 },
  ];
  const read = marks.length ? await ocrBoxes(full, [...boxes, ...strips]) : [];
  const texts = read.slice(0, marks.length);
  const passages = groupPassages(marks.map((m, i) => ({ text: texts[i]?.text ?? "", color: m.color, box: m.box })));
  const edge = read.slice(marks.length).flatMap((r, i) => r.text.split("\n").map((text) => ({ text, y: i === 0 ? 0 : full.height })));
  return { marks, passages, page: pageNumberOf(edge, full.height), scale, full };
}

export default function ScanHighlights({ onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [read, setRead] = useState<Read | null>(null);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [isbn, setIsbn] = useState("");
  const [page, setPage] = useState("");
  const [keep, setKeep] = useState(false);
  const photo = useRef<{ file: Blob; started: number } | null>(null);
  const preview = useRef<HTMLCanvasElement | null>(null);
  const trap = useRef<HTMLDivElement | null>(null);
  useFocusTrap(trap, { active: true, onEscape: onClose });

  const take = async (file: Blob | undefined | null) => {
    if (!file) return;
    photo.current = { file, started: performance.now() };
    setBusy(true);
    setRead(null);
    try {
      const r = await readPage(file, getLocale() === "he");
      setRead(r);
      if (r.page !== null) setPage(String(r.page));
      // The marks on a small copy of the photo, for checking before saving.
      const pv = preview.current;
      if (pv) {
        const { canvas } = scaled(r.full, 480);
        pv.width = canvas.width;
        pv.height = canvas.height;
        const g = pv.getContext("2d")!;
        g.drawImage(canvas, 0, 0);
        const k = canvas.width / (r.full.width * r.scale);
        g.lineWidth = 2;
        g.strokeStyle = "#e11d48";
        for (const m of r.marks) g.strokeRect(m.box.x0 * k, m.box.y0 * k, (m.box.x1 - m.box.x0) * k, (m.box.y1 - m.box.y0) * k);
      }
    } catch (e) {
      showAiToast(t("hlscan.failed", { error: explainError(e) }), "error");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => void take([...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/")));
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const isbnOk = !isbn.trim() || cleanIsbn(isbn) !== null;
  const passages = read?.passages ?? [];
  const canSave = !!title.trim() && passages.length > 0 && isbnOk && !busy;

  const save = async () => {
    if (!canSave || !read) return;
    const pageNo = /^\d{1,4}$/.test(page.trim()) ? Number(page.trim()) : null;
    const book = scannedBook({ title: title.trim(), author: author.trim(), isbn: cleanIsbn(isbn) ?? undefined }, passages, pageNo);
    try {
      const { writeSidecar } = await import("../sidecar");
      await writeBooks({ books: [book], skipped: {} }, writeSidecar);
      if (keep && photo.current) {
        const { writeWorkspaceBlob } = await import("../../storage/workspace");
        const note = bookNotePath(book);
        const dir = note.slice(0, note.lastIndexOf("/"));
        const type = photo.current.file.type;
        const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : type === "image/heic" ? "heic" : "jpg";
        await writeWorkspaceBlob(`${dir}/scans/${safeName(book.title)} p${pageNo ?? "x"}-${Date.now()}.${ext}`, photo.current.file);
      }
      const s = ((performance.now() - (photo.current?.started ?? performance.now())) / 1000).toFixed(1);
      showAiToast(t("hlscan.saved", { n: book.highlights.length, book: book.title, s }), "success");
      onClose();
    } catch (e) {
      showAiToast(t("hlscan.failed", { error: explainError(e) }), "error");
    }
  };

  const field = { display: "grid", gap: 2, fontSize: 12 } as const;
  return (
    <div className="cmd-palette-backdrop" onClick={onClose} ref={trap} role="dialog" aria-modal="true" aria-label={t("hlscan.title")} data-testid="scan-highlights">
      <div className="cmd-palette" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560, padding: 16, display: "grid", gap: 10, maxHeight: "85vh", overflowY: "auto" }}>
        <h2 style={{ margin: 0, fontSize: 15 }}>{t("hlscan.title")}</h2>
        <p style={{ margin: 0, fontSize: 12, color: "hsl(var(--fg-muted))" }}>{t("hlscan.intro")}</p>
        <label
          style={{ border: "1px dashed hsl(var(--border))", borderRadius: 8, padding: 16, textAlign: "center", cursor: "pointer", fontSize: 13 }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void take([...e.dataTransfer.files].find((f) => f.type.startsWith("image/")));
          }}
        >
          {t("hlscan.drop")}
          <input type="file" accept="image/*" capture="environment" style={{ display: "block", margin: "8px auto 0" }} aria-label={t("hlscan.pick")} data-testid="scan-file" onChange={(e) => void take(e.target.files?.[0])} />
        </label>
        <canvas ref={preview} style={{ maxInlineSize: "100%", display: read ? "block" : "none" }} aria-hidden="true" />
        {busy && <div role="status">{t("hlscan.reading")}</div>}
        {read && !busy && (
          <div role="status" data-testid="scan-found">
            {passages.length ? t("hlscan.found", { n: passages.length }) : t("hlscan.none")}
          </div>
        )}
        {passages.length > 0 && (
          <ol style={{ margin: 0, paddingInlineStart: 20, fontSize: 13, display: "grid", gap: 4 }} data-testid="scan-passages">
            {passages.map((p, i) => (
              <li key={i} dir="auto">
                <span style={{ fontSize: 11, color: "hsl(var(--fg-muted))" }}>{t(`hlscan.color.${p.color}`)} · </span>
                {p.text}
              </li>
            ))}
          </ol>
        )}
        <label style={field}>
          {t("hlscan.bookTitle")}
          <input value={title} dir="auto" onChange={(e) => setTitle(e.target.value)} data-testid="scan-title" />
        </label>
        <label style={field}>
          {t("hlscan.author")}
          <input value={author} dir="auto" onChange={(e) => setAuthor(e.target.value)} />
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <label style={{ ...field, flex: 1 }}>
            {t("hlscan.isbn")}
            <input value={isbn} dir="ltr" inputMode="numeric" onChange={(e) => setIsbn(e.target.value)} aria-invalid={!isbnOk} />
            {!isbnOk && <span role="alert" style={{ color: "hsl(0 80% 60%)" }}>{t("hlscan.isbnInvalid")}</span>}
          </label>
          <label style={{ ...field, inlineSize: 90 }}>
            {t("hlscan.page")}
            <input value={page} dir="ltr" inputMode="numeric" onChange={(e) => setPage(e.target.value)} data-testid="scan-page" />
          </label>
        </div>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
          {t("hlscan.keepPhoto")}
        </label>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose}>{t("hlscan.cancel")}</button>
          <button type="button" disabled={!canSave} onClick={() => void save()} data-testid="scan-save">
            {t("hlscan.save", { n: passages.length })}
          </button>
        </div>
      </div>
    </div>
  );
}
