import { useState, useEffect, useCallback, useMemo, type CSSProperties } from "react";
import { t } from "../i18n";

interface TourStep {
  target: string; // CSS selector
  titleKey: string;
  bodyKey: string;
  actionId?: string;
  placement: "top" | "bottom" | "left" | "right";
}

export interface TourAction {
  id: string;
  label: string;
  onRun: () => void;
}

const STEPS: TourStep[] = [
  {
    target: ".titlebar",
    titleKey: "tour.step.menu.title",
    bodyKey: "tour.step.menu.body",
    placement: "bottom",
  },
  {
    target: ".seg-group",
    titleKey: "tour.step.viewModes.title",
    bodyKey: "tour.step.viewModes.body",
    placement: "bottom",
  },
  {
    target: ".file-tree",
    titleKey: "tour.step.workspace.title",
    bodyKey: "tour.step.workspace.body",
    placement: "right",
  },
  {
    target: ".status-bar",
    titleKey: "tour.step.statusBar.title",
    bodyKey: "tour.step.statusBar.body",
    actionId: "runtimeMetrics.open",
    placement: "top",
  },
  {
    target: "main",
    titleKey: "tour.step.editor.title",
    bodyKey: "tour.step.editor.body",
    placement: "top",
  },
];

interface Props {
  open: boolean;
  onClose: () => void;
  actions?: TourAction[];
}

export function OnboardingTour({ open, onClose, actions }: Props) {
  const [step, setStep] = useState(0);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0, height: 0 });

  const current = STEPS[step];
  const actionById = useMemo(() => {
    const map = new Map<string, TourAction>();
    (actions ?? []).forEach((action) => map.set(action.id, action));
    return map;
  }, [actions]);
  const currentAction = useMemo(
    () => (current?.actionId ? actionById.get(current.actionId) ?? null : null),
    [current, actionById],
  );

  const updatePos = useCallback(() => {
    if (!current) return;
    const el = document.querySelector(current.target);
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ top: r.top, left: r.left, width: r.width, height: r.height });
    }
  }, [current]);

  useEffect(() => {
    if (!open) {
      setStep(0);
      return;
    }
    updatePos();
    window.addEventListener("resize", updatePos);
    return () => window.removeEventListener("resize", updatePos);
  }, [open, step, updatePos]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" || e.key === "Enter") {
        if (step < STEPS.length - 1) setStep(step + 1);
        else onClose();
      }
      if (e.key === "ArrowLeft" && step > 0) setStep(step - 1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, step, onClose]);

  if (!open || !current) return null;

  // Tooltip positioning. The popup uses position:fixed with viewport
  // coords. The original logic had two bugs:
  //   1. For "top" placement, the popup was anchored to pos.top-gap
  //      with no vertical translate — meaning it extended DOWN past
  //      the target's top edge instead of upward.
  //   2. For "left" placement, the popup was anchored to pos.left-gap
  //      with no horizontal translate — same issue, extended RIGHT
  //      over the target.
  // Plus a clamp bug: tooltips whose target centre sits within half-
  // a-tooltip of a viewport edge land partially off-screen.
  // Fix: switch all four placements to a single consistent strategy
  // — compute the tooltip's TOP-LEFT corner directly, then clamp.
  const gap = 12;
  const tooltipW = Math.min(
    320,
    (typeof window !== "undefined" ? window.innerWidth : 1280) * 0.8,
  );
  const tooltipApproxH = 200; // title + body + footer + breathing room
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 720;
  const MARGIN = 8;
  function clampLeft(x: number): number {
    return Math.max(MARGIN, Math.min(vw - tooltipW - MARGIN, x));
  }
  function clampTop(y: number): number {
    return Math.max(MARGIN, Math.min(vh - tooltipApproxH - MARGIN, y));
  }
  let topLeft: { top: number; left: number };
  switch (current.placement) {
    case "bottom":
      // Below the target, centred horizontally.
      topLeft = {
        top: pos.top + pos.height + gap,
        left: pos.left + pos.width / 2 - tooltipW / 2,
      };
      break;
    case "top":
      // Above the target, centred horizontally.
      topLeft = {
        top: pos.top - tooltipApproxH - gap,
        left: pos.left + pos.width / 2 - tooltipW / 2,
      };
      break;
    case "right":
      // To the right of the target, centred vertically.
      topLeft = {
        top: pos.top + pos.height / 2 - tooltipApproxH / 2,
        left: pos.left + pos.width + gap,
      };
      break;
    case "left":
      // To the left of the target, centred vertically.
      topLeft = {
        top: pos.top + pos.height / 2 - tooltipApproxH / 2,
        left: pos.left - tooltipW - gap,
      };
      break;
  }
  const tooltipStyle: CSSProperties = {
    top: clampTop(topLeft.top),
    left: clampLeft(topLeft.left),
  };

  return (
    <>
      {/* Overlay with spotlight cutout */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 9999,
          pointerEvents: "auto",
        }}
        onClick={onClose}
      >
        {/* Semi-transparent overlay */}
        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
          <defs>
            <mask id="spotlight-mask">
              <rect width="100%" height="100%" fill="white" />
              <rect
                x={pos.left - 6}
                y={pos.top - 6}
                width={pos.width + 12}
                height={pos.height + 12}
                rx={10}
                fill="black"
              />
            </mask>
          </defs>
          <rect
            width="100%"
            height="100%"
            fill="rgba(0,0,0,0.6)"
            mask="url(#spotlight-mask)"
          />
        </svg>
      </div>
      {/* Tooltip */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          zIndex: 10000,
          ...tooltipStyle,
          // tooltipStyle is top-left coordinates of the tooltip's outer
          // box (after clamping). No CSS transform needed.
          background: "hsl(var(--bg-muted))",
          border: "1px solid hsl(var(--accent) / 0.3)",
          borderRadius: 14,
          padding: "18px 22px",
          width: "min(320px, 80vw)",
          boxShadow: "0 12px 40px hsl(0 0% 0% / 0.5), 0 0 0 1px hsl(var(--accent) / 0.15)",
        }}
      >
        <h3
          style={{
            fontSize: 15,
            fontWeight: 700,
            marginBottom: 6,
            color: "hsl(var(--fg))",
          }}
        >
          {t(current.titleKey)}
        </h3>
        <p
          style={{
            fontSize: 12.5,
            color: "hsl(var(--fg-subtle))",
            lineHeight: 1.5,
            margin: 0,
          }}
        >
          {t(current.bodyKey)}
        </p>
        {/* Navigation */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 14,
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 11, color: "hsl(var(--fg-muted))" }}>
              {step + 1} / {STEPS.length}
            </span>
            {step < STEPS.length - 1 && (
              <button
                type="button"
                onClick={onClose}
                style={{ padding: 0, border: 0, background: "none", color: "hsl(var(--fg-muted))", fontSize: 11, textDecoration: "underline", cursor: "pointer", fontFamily: "inherit" }}
              >
                {t("onboard.tour.skip")}
              </button>
            )}
          </span>
        <div style={{ display: "flex", gap: 8 }}>
          {step > 0 && (
            <button
              onClick={() => setStep(step - 1)}
              style={{
                padding: "4px 12px",
                fontSize: 11,
                border: "1px solid hsl(var(--border))",
                borderRadius: 6,
                background: "transparent",
                color: "hsl(var(--fg-muted))",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              ←
            </button>
          )}
          {currentAction && (
            <button
              onClick={currentAction.onRun}
              style={{
                padding: "4px 14px",
                fontSize: 11,
                border: "1px solid hsl(var(--accent) / 0.5)",
                borderRadius: 6,
                background: "hsl(var(--accent) / 0.15)",
                color: "hsl(var(--accent))",
                cursor: "pointer",
                fontFamily: "inherit",
                fontWeight: 600,
              }}
            >
              {currentAction.label}
            </button>
          )}
          <button
            onClick={() => {
              if (step < STEPS.length - 1) setStep(step + 1);
              else onClose();
            }}
            style={{
              padding: "4px 14px",
              fontSize: 11,
              border: "1px solid hsl(var(--accent) / 0.5)",
              borderRadius: 6,
              background: "hsl(var(--accent) / 0.15)",
              color: "hsl(var(--accent))",
              cursor: "pointer",
              fontFamily: "inherit",
              fontWeight: 600,
            }}
          >
            {step < STEPS.length - 1 ? t("tour.next") : t("tour.done")}
          </button>
        </div>
        </div>
      </div>
    </>
  );
}
