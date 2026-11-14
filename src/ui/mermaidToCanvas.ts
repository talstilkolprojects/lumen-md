/**
 * Mermaid → editable canvas elements (plan W2.18), in the browser:
 * @excalidraw/mermaid-to-excalidraw (MIT, the version Excalidraw 0.18.1
 * ships with) lays the diagram out with Mermaid and returns element
 * skeletons; Excalidraw turns them into elements. Before that the definition
 * is cleaned and checked with the real Mermaid parser, and afterwards the
 * labels are counted, so a conversion that dropped something says so.
 *
 * Loaded on use (the converter's chunk is vendor-excalidraw-mermaid).
 */

import { checkMermaid } from "../agents/tools/validate";
import { expectedLabels, extractMermaid, missingLabels, precheck } from "../canvas/mermaidPrep";
import type { SceneElement } from "../canvas/excalidrawScene";

export class MermaidError extends Error {
  readonly kind: "empty" | "unknown" | "syntax";
  constructor(message: string, kind: "empty" | "unknown" | "syntax") {
    super(message);
    this.name = "MermaidError";
    this.kind = kind;
  }
}

export interface Converted {
  elements: SceneElement[];
  files: Record<string, unknown>;
  /** False for a type the converter draws as a picture (not one of the five editable ones). */
  editable: boolean;
  /** Labels of the definition not found among the elements. */
  missing: string[];
}

type Box = { x: number; y: number; width: number; height: number };

/** The elements' bounding box. */
export function boundsOf(els: readonly Box[]): Box {
  if (!els.length) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(...els.map((e) => e.x));
  const y = Math.min(...els.map((e) => e.y));
  return { x, y, width: Math.max(...els.map((e) => e.x + e.width)) - x, height: Math.max(...els.map((e) => e.y + e.height)) - y };
}

/** Moved so their box is centred on `at` (linear elements' points are relative, so x / y is enough). */
export function centredOn<T extends Box>(els: readonly T[], at: { x: number; y: number }): T[] {
  const b = boundsOf(els);
  const dx = at.x - (b.x + b.width / 2);
  const dy = at.y - (b.y + b.height / 2);
  return els.map((e) => ({ ...e, x: e.x + dx, y: e.y + dy }));
}

export async function mermaidToElements(input: string): Promise<Converted> {
  const code = extractMermaid(input);
  const pre = precheck(code);
  if (!pre.ok && pre.reason !== "not-editable") throw new MermaidError(pre.reason === "empty" ? "empty" : "unknown diagram type", pre.reason);
  const check = await checkMermaid(code);
  if (!check.ok) throw new MermaidError(check.error ?? "invalid Mermaid", "syntax");
  const [{ parseMermaidToExcalidraw }, { convertToExcalidrawElements }] = await Promise.all([import("@excalidraw/mermaid-to-excalidraw"), import("@excalidraw/excalidraw")]);
  const { elements: skeletons, files } = await parseMermaidToExcalidraw(code, { themeVariables: { fontSize: "20px" } });
  const elements = convertToExcalidrawElements(skeletons as Parameters<typeof convertToExcalidrawElements>[0], { regenerateIds: true }) as unknown as SceneElement[];
  const texts = (elements as unknown as Array<{ type: string; text?: string; isDeleted?: boolean }>).filter((e) => e.type === "text" && !e.isDeleted).map((e) => e.text ?? "");
  return { elements, files: (files ?? {}) as Record<string, unknown>, editable: pre.ok, missing: pre.ok ? missingLabels(expectedLabels(code), texts) : [] };
}
