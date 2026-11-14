/**
 * Plugin UI as data (plan 11.2.1/11.2.2). A plugin never gets a DOM: its
 * panel, settings and block renderers are a tree of a few element kinds
 * that the app renders itself (React, plan 11.2 part b). So there is no
 * channel to the outside by construction — no `<img src>`, no stylesheet,
 * no form action, no frame, no link to another site, no script — and the
 * acceptance list of 11.2 (fetch, WebSocket, image, CSS, form, iframe,
 * navigation) is refused here, before anything renders.
 *
 * Why not a sandboxed iframe with CSP `default-src 'none'` (the plan's
 * first idea): CSP and the `sandbox` attribute block every channel except
 * one — a frame may always navigate *itself*, and `navigate-to` never
 * shipped. One `location.href = "https://…?" + text` would leave. Data
 * cannot.
 */

export type UiNode =
  | { type: "text"; text: string }
  | { type: "heading"; level?: 1 | 2 | 3; text: string }
  | { type: "paragraph"; children: UiNode[] }
  | { type: "box"; direction?: "row" | "column"; gap?: number; children: UiNode[] }
  | { type: "list"; ordered?: boolean; items: UiNode[][] }
  | { type: "button"; id: string; label: string; primary?: boolean; disabled?: boolean }
  | { type: "input"; id: string; value?: string; placeholder?: string; multiline?: boolean }
  | { type: "checkbox"; id: string; checked?: boolean; label: string }
  | { type: "select"; id: string; value?: string; options: { value: string; label: string }[] }
  | { type: "code"; text: string; lang?: string }
  /** A link to a note in the vault (wikilink target), never to a URL. */
  | { type: "noteLink"; target: string; label?: string }
  | { type: "divider" };

export const UI_KINDS = ["text", "heading", "paragraph", "box", "list", "button", "input", "checkbox", "select", "code", "noteLink", "divider"] as const;

export class UiTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UiTreeError";
  }
}

export const UI_LIMITS = { maxNodes: 2000, maxDepth: 24, maxText: 20_000, maxOptions: 500 };

const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

function text(v: unknown, what: string, max = UI_LIMITS.maxText): string {
  if (typeof v !== "string") throw new UiTreeError(`${what} must be a string`);
  if (v.length > max) throw new UiTreeError(`${what} is longer than ${max} characters`);
  // No URL-ish escape through text: text is rendered as text, so anything goes except control chars.
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function id(v: unknown, what: string): string {
  if (typeof v !== "string" || !ID_RE.test(v)) throw new UiTreeError(`${what} must be an id of 1–64 letters, digits, "_", ".", ":" or "-"`);
  return v;
}

/**
 * Validate a tree a plugin sent. Returns a clean copy with only the known
 * fields; throws UiTreeError on anything else — an unknown kind (img,
 * iframe, form, link, style, script, html…), an unknown field, a URL
 * where a note name belongs, or a tree over the limits.
 */
export function validateUiTree(input: unknown): UiNode {
  let count = 0;
  const walk = (n: unknown, depth: number): UiNode => {
    if (++count > UI_LIMITS.maxNodes) throw new UiTreeError(`more than ${UI_LIMITS.maxNodes} nodes`);
    if (depth > UI_LIMITS.maxDepth) throw new UiTreeError(`deeper than ${UI_LIMITS.maxDepth} levels`);
    if (!n || typeof n !== "object" || Array.isArray(n)) throw new UiTreeError("a node must be an object");
    const o = n as Record<string, unknown>;
    const type = o.type;
    const allow = (...keys: string[]) => {
      for (const k of Object.keys(o)) if (k !== "type" && !keys.includes(k)) throw new UiTreeError(`${String(type)}: unknown field "${k}"`);
    };
    const children = (v: unknown, what: string): UiNode[] => {
      if (!Array.isArray(v)) throw new UiTreeError(`${what} must be an array`);
      return v.map((c) => walk(c, depth + 1));
    };
    switch (type) {
      case "text":
        allow("text");
        return { type, text: text(o.text, "text.text") };
      case "heading": {
        allow("level", "text");
        const level = o.level === undefined ? undefined : o.level;
        if (level !== undefined && level !== 1 && level !== 2 && level !== 3) throw new UiTreeError("heading.level must be 1, 2 or 3");
        return { type, ...(level !== undefined ? { level } : {}), text: text(o.text, "heading.text", 500) };
      }
      case "paragraph":
        allow("children");
        return { type, children: children(o.children, "paragraph.children") };
      case "box": {
        allow("direction", "gap", "children");
        if (o.direction !== undefined && o.direction !== "row" && o.direction !== "column") throw new UiTreeError("box.direction must be row or column");
        if (o.gap !== undefined && (typeof o.gap !== "number" || o.gap < 0 || o.gap > 48)) throw new UiTreeError("box.gap must be a number 0–48");
        return { type, ...(o.direction ? { direction: o.direction as "row" | "column" } : {}), ...(o.gap !== undefined ? { gap: o.gap as number } : {}), children: children(o.children, "box.children") };
      }
      case "list": {
        allow("ordered", "items");
        if (o.ordered !== undefined && typeof o.ordered !== "boolean") throw new UiTreeError("list.ordered must be a boolean");
        if (!Array.isArray(o.items)) throw new UiTreeError("list.items must be an array of arrays");
        return { type, ...(o.ordered ? { ordered: true } : {}), items: o.items.map((it, i) => children(it, `list.items[${i}]`)) };
      }
      case "button": {
        allow("id", "label", "primary", "disabled");
        if (o.primary !== undefined && typeof o.primary !== "boolean") throw new UiTreeError("button.primary must be a boolean");
        if (o.disabled !== undefined && typeof o.disabled !== "boolean") throw new UiTreeError("button.disabled must be a boolean");
        return { type, id: id(o.id, "button.id"), label: text(o.label, "button.label", 200), ...(o.primary ? { primary: true } : {}), ...(o.disabled ? { disabled: true } : {}) };
      }
      case "input": {
        allow("id", "value", "placeholder", "multiline");
        if (o.multiline !== undefined && typeof o.multiline !== "boolean") throw new UiTreeError("input.multiline must be a boolean");
        return {
          type,
          id: id(o.id, "input.id"),
          ...(o.value !== undefined ? { value: text(o.value, "input.value") } : {}),
          ...(o.placeholder !== undefined ? { placeholder: text(o.placeholder, "input.placeholder", 200) } : {}),
          ...(o.multiline ? { multiline: true } : {}),
        };
      }
      case "checkbox": {
        allow("id", "checked", "label");
        if (o.checked !== undefined && typeof o.checked !== "boolean") throw new UiTreeError("checkbox.checked must be a boolean");
        return { type, id: id(o.id, "checkbox.id"), ...(o.checked ? { checked: true } : {}), label: text(o.label, "checkbox.label", 500) };
      }
      case "select": {
        allow("id", "value", "options");
        if (!Array.isArray(o.options) || o.options.length > UI_LIMITS.maxOptions) throw new UiTreeError(`select.options must be an array of at most ${UI_LIMITS.maxOptions}`);
        const options = o.options.map((op, i) => {
          if (!op || typeof op !== "object") throw new UiTreeError(`select.options[${i}] must be { value, label }`);
          const oo = op as Record<string, unknown>;
          for (const k of Object.keys(oo)) if (k !== "value" && k !== "label") throw new UiTreeError(`select.options[${i}]: unknown field "${k}"`);
          return { value: text(oo.value, `select.options[${i}].value`, 200), label: text(oo.label, `select.options[${i}].label`, 200) };
        });
        return { type, id: id(o.id, "select.id"), ...(o.value !== undefined ? { value: text(o.value, "select.value", 200) } : {}), options };
      }
      case "code": {
        allow("text", "lang");
        if (o.lang !== undefined && (typeof o.lang !== "string" || !/^[a-z0-9+#-]{1,20}$/i.test(o.lang))) throw new UiTreeError("code.lang must be a short language name");
        return { type, text: text(o.text, "code.text"), ...(o.lang ? { lang: o.lang as string } : {}) };
      }
      case "noteLink": {
        allow("target", "label");
        const target = text(o.target, "noteLink.target", 500);
        // A note name or vault-relative path: never a URL, never outside the vault.
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//") || /(^|\/)\.\.(\/|$)/.test(target) || target.startsWith("/")) throw new UiTreeError("noteLink.target must name a note in the vault, not a URL or a path outside it");
        return { type, target, ...(o.label !== undefined ? { label: text(o.label, "noteLink.label", 200) } : {}) };
      }
      case "divider":
        allow();
        return { type };
      default:
        throw new UiTreeError(`unknown element kind ${JSON.stringify(type)} — plugins render ${UI_KINDS.join(", ")} only`);
    }
  };
  return walk(input, 1);
}
