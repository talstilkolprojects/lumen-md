/**
 * The editing toolbar above the on-screen keyboard (plans 10.2 → W1.25).
 *
 * Shown on touch screens while the source editor has focus, pinned to the
 * top of the keyboard (VisualViewport tells where that is). The row is the
 * user's own (store `mobileToolbar`): the ⋯ button at its end opens a sheet
 * to add, remove and reorder actions. Buttons are 44 × 44 like every touch
 * target (10.2), the row scrolls sideways when it is longer than the
 * screen, and in Hebrew it starts at the right and its arrows point the way
 * the text moves.
 *
 * A tap sends `lumen-mobile-action` {id}; the editor applies it as one
 * transaction (one undo step). `mousedown` is cancelled so the editor keeps
 * focus and the keyboard stays up.
 */

import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { actionById, DEFAULT_TOOLBAR, moveAction, sanitizeToolbar, toggleAction, TOOLBAR_ACTIONS, type ToolbarActionId } from "../mobile/toolbarActions";
import { useAppStore } from "../store/useStore";
import { useFocusTrap } from "./useFocusTrap";
import "./mobileKeyboardBarStrings";
import { HelpButton } from "./HelpButton";

export const MOBILE_ACTION_EVENT = "lumen-mobile-action";

/** Send one toolbar action to the focused editor. */
export function runMobileAction(id: ToolbarActionId): void {
  window.dispatchEvent(new CustomEvent(MOBILE_ACTION_EVENT, { detail: { id } }));
}

const isRtl = () => typeof document !== "undefined" && document.documentElement.dir === "rtl";

/** Is focus in the source editor (CodeMirror)? */
function editorFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el?.closest?.(".cm-editor");
}

/** Pixels the on-screen keyboard covers at the bottom of the layout viewport. */
function keyboardInset(): number {
  const vv = window.visualViewport;
  if (!vv) return 0;
  return Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
}

const btn: React.CSSProperties = {
  // Physical sizes on purpose: a square has no direction.
  minWidth: 44,
  height: 44,
  paddingInline: 8,
  border: "none",
  borderRadius: 8,
  background: "transparent",
  color: "hsl(var(--fg))",
  fontSize: 17,
  lineHeight: 1,
  flexShrink: 0,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

/** `startCustomizing`: the host loaded the bar for the customise sheet (palette → Customize mobile toolbar). */
export function MobileKeyboardBar({ startCustomizing = false }: { startCustomizing?: boolean } = {}) {
  const row = useAppStore((s) => s.mobileToolbar) ?? DEFAULT_TOOLBAR;
  const [visible, setVisible] = useState(false);
  const [inset, setInset] = useState(0);
  const [customizing, setCustomizing] = useState(startCustomizing);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    if (!window.matchMedia("(pointer: coarse)").matches) return;
    const update = () => {
      setVisible(editorFocused());
      setInset(keyboardInset());
    };
    const vv = window.visualViewport;
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    update();
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
    };
  }, []);

  useEffect(() => {
    const open = () => setCustomizing(true);
    window.addEventListener("lumen-mobile-customize", open);
    return () => window.removeEventListener("lumen-mobile-customize", open);
  }, []);

  const rtl = isRtl();
  return (
    <>
      {visible && (
        <div
          role="toolbar"
          aria-label={t("mobileBar.label")}
          data-testid="mobile-toolbar"
          style={{
            position: "fixed",
            insetInlineStart: 0,
            insetInlineEnd: 0,
            bottom: inset,
            display: "flex",
            gap: 2,
            paddingInline: "max(4px, env(safe-area-inset-left))",
            paddingBlockEnd: inset ? 0 : "env(safe-area-inset-bottom)",
            background: "hsl(var(--bg-subtle))",
            borderBlockStart: "1px solid hsl(var(--border))",
            overflowX: "auto",
            whiteSpace: "nowrap",
            zIndex: 50,
            WebkitOverflowScrolling: "touch",
          }}
        >
          {row.map((id) => {
            const a = actionById(id);
            if (!a) return null;
            return (
              <button
                key={id}
                type="button"
                aria-label={t(a.labelKey)}
                title={t(a.labelKey)}
                data-action={id}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => runMobileAction(id)}
                style={{ ...btn, fontWeight: id === "bold" ? 700 : undefined, fontStyle: id === "italic" ? "italic" : undefined }}
              >
                <span aria-hidden="true" style={a.mirror && rtl ? { display: "inline-block", transform: "scaleX(-1)" } : undefined}>
                  {a.glyph}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            aria-label={t("mobileBar.customize")}
            title={t("mobileBar.customize")}
            data-action="customize"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setCustomizing(true)}
            style={{ ...btn, marginInlineStart: "auto", color: "hsl(var(--fg-muted))" }}
          >
            <span aria-hidden="true">⋯</span>
          </button>
        </div>
      )}
      {customizing && <MobileToolbarSheet onClose={() => setCustomizing(false)} />}
    </>
  );
}

/** Add, remove and reorder the toolbar's actions. Buttons, not drag, so it works with a screen reader and one thumb. */
export function MobileToolbarSheet({ onClose }: { onClose: () => void }) {
  const row = sanitizeToolbar(useAppStore((s) => s.mobileToolbar));
  const set = useAppStore((s) => s.setMobileToolbar);
  const ref = useRef<HTMLDivElement | null>(null);
  useFocusTrap(ref, { onEscape: onClose });
  const off = TOOLBAR_ACTIONS.filter((a) => !row.includes(a.id));
  const item: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, minBlockSize: 44, borderBlockEnd: "1px solid hsl(var(--border))" };
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, background: "var(--overlay)", display: "flex", alignItems: "flex-end" }} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-toolbar-sheet-title"
        data-testid="mobile-toolbar-sheet"
        style={{ inlineSize: "100%", maxBlockSize: "80vh", overflowY: "auto", background: "hsl(var(--bg))", borderStartStartRadius: 14, borderStartEndRadius: 14, padding: "12px 16px", paddingBlockEnd: "max(12px, env(safe-area-inset-bottom))" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBlockEnd: 8 }}>
          <h2 id="mobile-toolbar-sheet-title" style={{ flex: 1, fontSize: 16, fontWeight: 600, margin: 0 }}>
            {t("mobileBar.customize.title")}
          </h2>
          <HelpButton topic="editor/touch#the-editing-toolbar" />
          <button type="button" style={btn} onClick={() => set([...DEFAULT_TOOLBAR])}>
            {t("mobileBar.customize.reset")}
          </button>
          <button type="button" style={btn} aria-label={t("mobileBar.customize.done")} onClick={onClose} data-autofocus>
            {t("mobileBar.customize.done")}
          </button>
        </div>
        <p style={{ fontSize: 13, color: "hsl(var(--fg-muted))", margin: "0 0 8px" }}>{t("mobileBar.customize.intro")}</p>
        <ul aria-label={t("mobileBar.customize.inRow")} style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {row.map((id, i) => {
            const a = actionById(id)!;
            const name = t(a.labelKey);
            return (
              <li key={id} style={item} data-row-item={id}>
                <span aria-hidden="true" style={{ inlineSize: 28, textAlign: "center" }}>
                  {a.glyph}
                </span>
                <span style={{ flex: 1 }}>{name}</span>
                <button type="button" style={btn} disabled={i === 0} aria-label={t("mobileBar.customize.up", { name })} onClick={() => set(moveAction(row, id, -1))}>
                  ↑
                </button>
                <button type="button" style={btn} disabled={i === row.length - 1} aria-label={t("mobileBar.customize.down", { name })} onClick={() => set(moveAction(row, id, 1))}>
                  ↓
                </button>
                <button type="button" style={btn} disabled={row.length === 1} aria-label={t("mobileBar.customize.remove", { name })} onClick={() => set(toggleAction(row, id))}>
                  −
                </button>
              </li>
            );
          })}
        </ul>
        {off.length > 0 && (
          <>
            <h3 style={{ fontSize: 13, fontWeight: 600, margin: "12px 0 4px", color: "hsl(var(--fg-muted))" }}>{t("mobileBar.customize.more")}</h3>
            <ul aria-label={t("mobileBar.customize.more")} style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {off.map((a) => {
                const name = t(a.labelKey);
                return (
                  <li key={a.id} style={item}>
                    <span aria-hidden="true" style={{ inlineSize: 28, textAlign: "center" }}>
                      {a.glyph}
                    </span>
                    <span style={{ flex: 1 }}>{name}</span>
                    <button type="button" style={btn} aria-label={t("mobileBar.customize.add", { name })} onClick={() => set(toggleAction(row, a.id))}>
                      +
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
