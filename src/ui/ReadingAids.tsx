/**
 * Reading aids (plan W5.6), opened from the palette: show niqqud on the
 * preview for reading (never written to the note), the dyslexia-friendly
 * layout, and read-aloud with the word highlighted. Lazy-loaded; its
 * English travels with it (../reading/readingAidsStrings).
 */
import { useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import "../reading/readingAidsStrings";
import { getLocale, t } from "../i18n";
import { useFocusTrap } from "./useFocusTrap";
import { uiConfirm } from "./PromptDialog";
import { showAiToast } from "./AiToast";
import { AIDS_FONTS, AIDS_LIMITS, AIDS_TINTS, applyAids, loadAids, saveAids, type ReadingAids } from "../reading/readingAids";
import { watchDisplayNikud, type PointMany } from "../reading/displayNikud";
import { HelpButton } from "./HelpButton";

let nikudWatch: { stop: () => void } | null = null;

/** Is "Show niqqud" on in this session? */
export function displayNikudOn(): boolean {
  return nikudWatch !== null;
}

/** The on-device niqqud model (plan 6.3) as a batch pointer: one call per batch, the texts joined by newlines (the model keeps every character). */
async function nakdimonPointer(): Promise<PointMany> {
  const svc = await import("../ai/nikudService");
  const deps = { consent: { confirm: uiConfirm, t, locale: getLocale() } };
  return async (texts) => {
    if (texts.some((x) => x.includes("\n"))) return Promise.all(texts.map((x) => svc.pointHebrew(x, deps)));
    const out = (await svc.pointHebrew(texts.join("\n"), deps)).split("\n");
    return out.length === texts.length ? out : Promise.all(texts.map((x) => svc.pointHebrew(x, deps)));
  };
}

/** Turn "Show niqqud" on or off. Returns whether it is on. `pointer`: tests. */
export async function toggleDisplayNikud(on = !displayNikudOn(), pointer?: PointMany): Promise<boolean> {
  nikudWatch?.stop();
  nikudWatch = null;
  if (!on) return false;
  const point = pointer ?? (await nakdimonPointer());
  const failed = (e: unknown) => {
    nikudWatch?.stop();
    nikudWatch = null;
    const reason = (e as { name?: string; reason?: string }).name === "NikudUnavailableError" ? (e as { reason: string }).reason : null;
    showAiToast(reason ? t(`toast.nikud.${reason}`) : t("readingAids.nikud.failed", { error: (e as Error).message }), reason ? "info" : "error");
  };
  const w = watchDisplayNikud(point, { onError: failed });
  nikudWatch = w;
  await w.ready;
  return displayNikudOn();
}

const row: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, margin: "8px 0" };
const control: CSSProperties = { border: "1px solid hsl(var(--border-strong))", borderRadius: 6, padding: "4px 8px", background: "transparent", color: "inherit" };

function Panel({ close }: { close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, { onEscape: close });
  const [aids, setAids] = useState<ReadingAids>(loadAids);
  const [nikud, setNikud] = useState(displayNikudOn());
  const [busy, setBusy] = useState(false);
  const update = (patch: Partial<ReadingAids>) => {
    const next = { ...aids, ...patch };
    setAids(next);
    saveAids(next);
    applyAids(next);
  };
  const slider = (key: "letterSpacing" | "wordSpacing" | "lineHeight" | "rate", unit: string) => {
    const lim = AIDS_LIMITS[key];
    const id = `ra-${key}`;
    return (
      <div style={row}>
        <label htmlFor={id}>{t(`readingAids.${key}`)}</label>
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input id={id} type="range" min={lim.min} max={lim.max} step={lim.step} value={aids[key]} onChange={(e) => update({ [key]: Number(e.target.value) })} />
          <output htmlFor={id} style={{ minWidth: 52, fontVariantNumeric: "tabular-nums" }} dir="ltr">
            {aids[key].toFixed(2)}
            {unit}
          </output>
        </span>
      </div>
    );
  };
  return (
    <div onClick={(e) => e.target === e.currentTarget && close()} style={{ position: "fixed", inset: 0, zIndex: 9999, background: "var(--overlay)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="ra-title" tabIndex={-1} style={{ background: "hsl(var(--bg))", color: "hsl(var(--fg))", border: "1px solid hsl(var(--border-strong))", borderRadius: 12, padding: 20, maxWidth: 520, width: "100%", maxHeight: "85vh", overflow: "auto", fontSize: 14 }}>
        <h2 id="ra-title" style={{ marginTop: 0 }}>
          {t("readingAids.title")}
        </h2>
        <HelpButton topic="editor/reading-aids" />

        <fieldset style={{ border: 0, padding: 0, margin: "0 0 12px" }}>
          <legend style={{ fontWeight: 600 }}>{t("readingAids.nikud.legend")}</legend>
          <label style={row}>
            <span>{t("readingAids.nikud.show")}</span>
            <input
              type="checkbox"
              checked={nikud}
              disabled={busy}
              data-testid="ra-nikud"
              onChange={async (e) => {
                setBusy(true);
                try {
                  setNikud(await toggleDisplayNikud(e.target.checked));
                } finally {
                  setBusy(false);
                }
              }}
            />
          </label>
          <p style={{ margin: 0, opacity: 0.8, fontSize: 12 }}>{t("readingAids.nikud.note")}</p>
        </fieldset>

        <fieldset style={{ border: 0, padding: 0, margin: "0 0 12px" }}>
          <legend style={{ fontWeight: 600 }}>{t("readingAids.dyslexia.legend")}</legend>
          <label style={row}>
            <span>{t("readingAids.dyslexia.on")}</span>
            <input type="checkbox" data-testid="ra-dyslexia" checked={aids.dyslexia} onChange={(e) => update({ dyslexia: e.target.checked })} />
          </label>
          <div style={row}>
            <label htmlFor="ra-font">{t("readingAids.font")}</label>
            <select id="ra-font" style={control} value={aids.font} disabled={!aids.dyslexia} onChange={(e) => update({ font: e.target.value as ReadingAids["font"] })}>
              {AIDS_FONTS.map((f) => (
                <option key={f} value={f}>
                  {t(`readingAids.font.${f}`)}
                </option>
              ))}
            </select>
          </div>
          {slider("letterSpacing", "em")}
          {slider("wordSpacing", "em")}
          {slider("lineHeight", "")}
          <label style={row}>
            <span>{t("readingAids.lineFocus")}</span>
            <input type="checkbox" checked={aids.lineFocus} disabled={!aids.dyslexia} onChange={(e) => update({ lineFocus: e.target.checked })} />
          </label>
          <div style={row}>
            <label htmlFor="ra-tint">{t("readingAids.tint")}</label>
            <select id="ra-tint" style={control} value={aids.tint} disabled={!aids.dyslexia} onChange={(e) => update({ tint: e.target.value as ReadingAids["tint"] })}>
              {AIDS_TINTS.map((x) => (
                <option key={x} value={x}>
                  {t(`readingAids.tint.${x}`)}
                </option>
              ))}
            </select>
          </div>
        </fieldset>

        <fieldset style={{ border: 0, padding: 0, margin: "0 0 12px" }}>
          <legend style={{ fontWeight: 600 }}>{t("readingAids.read.legend")}</legend>
          {slider("rate", "×")}
          <p style={{ margin: 0, opacity: 0.8, fontSize: 12 }}>{t("readingAids.read.note")}</p>
        </fieldset>

        <button type="button" onClick={close} style={{ ...control, padding: "4px 12px", cursor: "pointer" }}>
          {t("readingAids.close")}
        </button>
      </div>
    </div>
  );
}

export function openReadingAids(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => {
    root.unmount();
    host.remove();
  };
  root.render(<Panel close={close} />);
}
