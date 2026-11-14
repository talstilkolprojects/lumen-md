/**
 * Conflict-resolution dialog — opens when cloud sync finds that both
 * local and remote sides changed since the last sync.
 *
 * Renders the 3-way diff (`threeWayDiff`) as a side-by-side view, with
 * radio toggles for each `conflict` hunk. Auto-merge hunks render
 * read-only so the user can see what they're getting.
 *
 * Returns one of:
 *   • `{ kind: "merged", content }` — apply the merged content
 *   • `{ kind: "local"  }`           — take local wholesale
 *   • `{ kind: "remote" }`           — take remote wholesale
 *   • `null`                         — cancelled
 */

import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { applyMerge, threeWayDiff, type DiffHunk } from "./diff";

export type ConflictChoice =
  | { kind: "merged"; content: string }
  | { kind: "local" }
  | { kind: "remote" }
  | null;

/**
 * Wording of the dialog. Cloud sync uses the defaults; a change made outside
 * Lumen (plan 4.4) passes its own, translated labels.
 */
export interface ConflictLabels {
  title: string;
  description: string;
  local: string;
  remote: string;
  takeLocal: string;
  takeRemote: string;
  merge: string;
  cancel: string;
}

interface Props {
  path: string;
  base: string;
  local: string;
  remote: string;
  labels?: Partial<ConflictLabels>;
  onResolve: (choice: ConflictChoice) => void;
}

function ConflictDialogImpl({ path, base, local, remote, labels, onResolve }: Props) {
  const L: ConflictLabels = {
    title: `Sync conflict — ${path}`,
    description: "Both sides changed since the last sync. Pick what to keep, or take one side wholesale.",
    local: "local",
    remote: "remote",
    takeLocal: "Take local",
    takeRemote: "Take remote",
    merge: "Apply merge",
    cancel: "Cancel",
    ...labels,
  };
  const hunks = useMemo<DiffHunk[]>(
    () => threeWayDiff(base, local, remote),
    [base, local, remote],
  );
  const conflictHunkIdxs = hunks
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => h.op === "conflict")
    .map(({ i }) => i);
  const [picks, setPicks] = useState<Array<"local" | "remote" | "both">>(
    () => conflictHunkIdxs.map(() => "local"),
  );

  function setPick(idx: number, val: "local" | "remote" | "both") {
    const next = [...picks];
    next[idx] = val;
    setPicks(next);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "hsl(0 0% 0% / 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: 16,
      }}
    >
      <div
        style={{
          background: "hsl(var(--bg))",
          color: "hsl(var(--fg))",
          border: "1px solid hsl(var(--border-strong))",
          borderRadius: 12,
          width: "min(960px, 100vw - 32px)",
          maxHeight: "calc(100vh - 64px)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            padding: "12px 18px",
            borderBottom: "1px solid hsl(var(--border))",
          }}
        >
          <div id="conflict-title" style={{ fontWeight: 700, fontSize: 15 }}>
            {L.title}
          </div>
          <div style={{ fontSize: 12, color: "hsl(var(--fg-muted))", marginTop: 2 }}>
            {L.description}
          </div>
        </header>

        <div style={{ overflow: "auto", flex: 1, fontFamily: "JetBrains Mono, ui-monospace, monospace", fontSize: 12 }}>
          {hunks.map((h, i) => {
            const conflictPickIdx = conflictHunkIdxs.indexOf(i);
            return (
              <div
                key={i}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 0,
                  borderBottom: "1px solid hsl(var(--border))",
                  background:
                    h.op === "conflict"
                      ? "hsl(0 80% 60% / 0.06)"
                      : h.op === "local"
                        ? "hsl(258 60% 60% / 0.06)"
                        : h.op === "remote"
                          ? "hsl(190 60% 60% / 0.06)"
                          : undefined,
                }}
              >
                <Side
                  hunk={h}
                  side="local"
                  isPicked={
                    h.op === "local" ||
                    h.op === "equal" ||
                    h.op === "both" ||
                    (h.op === "conflict" && picks[conflictPickIdx] !== "remote")
                  }
                  onPick={
                    h.op === "conflict"
                      ? () => setPick(conflictPickIdx, "local")
                      : undefined
                  }
                />
                <Side
                  hunk={h}
                  side="remote"
                  isPicked={
                    h.op === "remote" ||
                    h.op === "equal" ||
                    h.op === "both" ||
                    (h.op === "conflict" && picks[conflictPickIdx] !== "local")
                  }
                  onPick={
                    h.op === "conflict"
                      ? () => setPick(conflictPickIdx, "remote")
                      : undefined
                  }
                />
                {h.op === "conflict" && (
                  <div style={{ gridColumn: "1 / span 2", padding: "4px 12px", fontSize: 11, color: "hsl(var(--fg-muted))", display: "flex", gap: 12 }}>
                    <label>
                      <input type="radio" checked={picks[conflictPickIdx] === "local"} onChange={() => setPick(conflictPickIdx, "local")} /> {L.local}
                    </label>
                    <label>
                      <input type="radio" checked={picks[conflictPickIdx] === "remote"} onChange={() => setPick(conflictPickIdx, "remote")} /> {L.remote}
                    </label>
                    <label>
                      <input type="radio" checked={picks[conflictPickIdx] === "both"} onChange={() => setPick(conflictPickIdx, "both")} /> both
                    </label>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <footer
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            padding: "12px 18px",
            borderTop: "1px solid hsl(var(--border))",
          }}
        >
          <button onClick={() => onResolve(null)} style={btnSecondary}>{L.cancel}</button>
          <button onClick={() => onResolve({ kind: "local" })} style={btnSecondary}>{L.takeLocal}</button>
          <button onClick={() => onResolve({ kind: "remote" })} style={btnSecondary}>{L.takeRemote}</button>
          <button
            onClick={() =>
              onResolve({
                kind: "merged",
                content: applyMerge(hunks, picks),
              })
            }
            style={btnPrimary}
          >
            {L.merge}
          </button>
        </footer>
      </div>
    </div>
  );
}

interface SideProps {
  hunk: DiffHunk;
  side: "local" | "remote";
  isPicked: boolean;
  onPick?: () => void;
}

function Side({ hunk, side, isPicked, onPick }: SideProps) {
  const lines = side === "local" ? hunk.local : hunk.remote;
  return (
    <div
      onClick={onPick}
      style={{
        padding: "6px 12px",
        opacity: isPicked ? 1 : 0.4,
        cursor: onPick ? "pointer" : "default",
        whiteSpace: "pre-wrap",
        borderInlineEnd: side === "local" ? "1px solid hsl(var(--border))" : undefined,
      }}
    >
      {lines.length === 0 ? (
        <span style={{ color: "hsl(var(--fg-muted))", fontStyle: "italic", fontSize: 11 }}>(empty)</span>
      ) : (
        lines.map((l, i) => (
          <div key={i}>{l || "\u00A0"}</div>
        ))
      )}
    </div>
  );
}

const btnSecondary: React.CSSProperties = {
  padding: "6px 14px",
  fontSize: 12,
  border: "1px solid hsl(var(--border))",
  borderRadius: 6,
  background: "transparent",
  color: "hsl(var(--fg))",
  cursor: "pointer",
};
const btnPrimary: React.CSSProperties = {
  padding: "6px 14px",
  fontSize: 12,
  border: "none",
  borderRadius: 6,
  background: "hsl(var(--accent))",
  color: "white",
  cursor: "pointer",
};

/**
 * Imperative entrypoint — opens the dialog and resolves the promise
 * with the user's choice. Mirrors the `uiPrompt` / `uiConfirm` flow
 * used elsewhere in Lumen.
 */
export function openConflictDialog(opts: {
  path: string;
  base: string;
  local: string;
  remote: string;
  labels?: Partial<ConflictLabels>;
}): Promise<ConflictChoice> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const cleanup = () => {
      try {
        root.unmount();
      } catch {
        /* */
      }
      host.remove();
    };
    root.render(
      <ConflictDialogImpl
        {...opts}
        onResolve={(v) => {
          cleanup();
          resolve(v);
        }}
      />,
    );
  });
}
