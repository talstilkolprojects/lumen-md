/**
 * Renders a plugin's UI tree (uiTree.ts) with the app's own elements. No
 * plugin string ever becomes markup, a URL, a style or an attribute name:
 * text is text, ids are data attributes, a note link opens a note.
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import type { UiNode } from "./uiTree";

export interface UiEvent {
  id: string;
  kind: "click" | "change";
  value?: string | boolean;
}

const btn: CSSProperties = { border: "1px solid hsl(var(--border-strong))", borderRadius: 6, padding: "3px 10px", background: "transparent", color: "inherit", cursor: "pointer", font: "inherit" };

function Input({ node, onEvent }: { node: Extract<UiNode, { type: "input" }>; onEvent: (e: UiEvent) => void }) {
  const [value, setValue] = useState(node.value ?? "");
  const props = {
    value,
    placeholder: node.placeholder,
    "data-plugin-ui": node.id,
    dir: "auto" as const,
    onChange: (e: { target: { value: string } }) => setValue(e.target.value),
    onBlur: () => onEvent({ id: node.id, kind: "change", value }),
    style: { font: "inherit", width: "100%", padding: 4, border: "1px solid hsl(var(--border))", borderRadius: 4, background: "hsl(var(--bg))", color: "inherit" },
  };
  return node.multiline ? <textarea rows={4} {...props} /> : <input type="text" {...props} />;
}

export function UiTreeView({ node, onEvent, onOpenNote }: { node: UiNode; onEvent: (e: UiEvent) => void; onOpenNote: (target: string) => void }): ReactNode {
  const kids = (list: UiNode[]) => list.map((c, i) => <UiTreeView key={i} node={c} onEvent={onEvent} onOpenNote={onOpenNote} />);
  switch (node.type) {
    case "text":
      return <span dir="auto">{node.text}</span>;
    case "heading": {
      const H = (`h${(node.level ?? 2) + 2}` as "h3" | "h4" | "h5");
      return <H dir="auto" style={{ margin: "6px 0" }}>{node.text}</H>;
    }
    case "paragraph":
      return <p dir="auto" style={{ margin: "4px 0" }}>{kids(node.children)}</p>;
    case "box":
      return <div style={{ display: "flex", flexDirection: node.direction ?? "column", gap: node.gap ?? 6, flexWrap: node.direction === "row" ? "wrap" : undefined }}>{kids(node.children)}</div>;
    case "list": {
      const L = node.ordered ? "ol" : "ul";
      return <L style={{ margin: "4px 0", paddingInlineStart: 20 }}>{node.items.map((it, i) => <li key={i} dir="auto">{kids(it)}</li>)}</L>;
    }
    case "button":
      return (
        <button type="button" data-plugin-ui={node.id} disabled={node.disabled} onClick={() => onEvent({ id: node.id, kind: "click" })} style={{ ...btn, ...(node.primary ? { background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))" } : {}) }}>
          {node.label}
        </button>
      );
    case "input":
      return <Input node={node} onEvent={onEvent} />;
    case "checkbox":
      return (
        <label dir="auto" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" data-plugin-ui={node.id} defaultChecked={node.checked} onChange={(e) => onEvent({ id: node.id, kind: "change", value: e.target.checked })} />
          {node.label}
        </label>
      );
    case "select":
      return (
        <select data-plugin-ui={node.id} defaultValue={node.value} onChange={(e) => onEvent({ id: node.id, kind: "change", value: e.target.value })} style={{ font: "inherit" }}>
          {node.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case "code":
      return (
        <pre dir="ltr" style={{ margin: "4px 0", overflow: "auto" }}>
          <code>{node.text}</code>
        </pre>
      );
    case "noteLink":
      return (
        <button type="button" onClick={() => onOpenNote(node.target)} style={{ ...btn, border: "none", padding: 0, textDecoration: "underline", color: "hsl(var(--primary))" }} dir="auto">
          {node.label ?? node.target}
        </button>
      );
    case "divider":
      return <hr style={{ border: "none", borderTop: "1px solid hsl(var(--border))", margin: "6px 0" }} />;
  }
}
