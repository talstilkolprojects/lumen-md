/**
 * Mermaid for the canvas (plan W2.18), the pure part: get a clean Mermaid
 * definition out of what a person pasted or a local model wrote, say which
 * diagram it is, and list the labels it has — so the conversion can be
 * checked for missing elements and the "draw me" answer can be judged
 * before it is converted.
 *
 * The five diagram types @excalidraw/mermaid-to-excalidraw 2.2.2 turns into
 * editable shapes: flowchart, sequence, class, state, ER. Any other type is
 * converted to a picture of the diagram (not editable) by the library; we
 * say so before inserting it.
 *
 * Pure: no DOM, no Mermaid import (the real parse is ../agents/tools/validate).
 */

export type DiagramKind = "flowchart" | "sequence" | "class" | "state" | "er";
export const EDITABLE_KINDS: readonly DiagramKind[] = ["flowchart", "sequence", "class", "state", "er"];

const HEADERS: Array<[RegExp, DiagramKind | "other"]> = [
  [/^(?:flowchart|graph)\b/, "flowchart"],
  [/^sequenceDiagram\b/, "sequence"],
  [/^classDiagram(?:-v2)?\b/, "class"],
  [/^stateDiagram(?:-v2)?\b/, "state"],
  [/^erDiagram\b/, "er"],
  [/^(?:mindmap|gantt|pie|journey|gitGraph|timeline|quadrantChart|requirementDiagram|C4\w*|sankey(?:-beta)?|xychart(?:-beta)?|block(?:-beta)?|packet(?:-beta)?|kanban|architecture(?:-beta)?|radar(?:-beta)?|treemap(?:-beta)?)\b/, "other"],
];

/** The diagram type from the first line that isn't a comment, directive or frontmatter. */
export function diagramKind(code: string): DiagramKind | "other" | null {
  const first = meaningfulLines(code)[0];
  if (!first) return null;
  for (const [re, kind] of HEADERS) if (re.test(first)) return kind;
  return null;
}

function meaningfulLines(code: string): string[] {
  const body = code.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("%%"));
}

/**
 * A Mermaid definition from pasted text or a model's answer: the first
 * ```mermaid fence if there is one, else the text from its first diagram
 * header; typographic quotes and arrows that models write are made ASCII,
 * and a trailing chat sentence after the diagram is dropped.
 */
export function extractMermaid(text: string): string {
  const fence = /```[ \t]*(?:mermaid)?[ \t]*\n([\s\S]*?)```/i.exec(text);
  let code = fence ? fence[1] : text;
  const lines = code.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((l) => HEADERS.some(([re]) => re.test(l.trim())));
  if (start > 0 && !/^---\s*$/.test(lines[0].trim())) code = lines.slice(start).join("\n");
  code = code
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\u2013>|\u2014>|\u2192/g, "-->")
    .replace(/\u00A0/g, " ");
  // A model's closing remark ("This diagram shows …") after a blank line isn't Mermaid.
  const parts = code.split(/\n\s*\n(?=[A-Z][a-z]+ [a-z]+[^\n]*[.!]\s*$)/);
  return parts[0].trim();
}

const unquote = (s: string) => s.trim().replace(/^"(.*)"$/s, "$1").replace(/^`(.*)`$/s, "$1").replace(/<br\s*\/?>/gi, "\n").trim();

/**
 * The texts a converted diagram must show: node / actor / class / state /
 * entity labels and edge / message / relation labels. Used to check that no
 * element went missing in the conversion.
 */
export function expectedLabels(code: string): { nodes: string[]; edges: string[] } {
  const kind = diagramKind(code);
  const lines = meaningfulLines(code).slice(1);
  const nodes = new Set<string>();
  const edges: string[] = [];
  if (kind === "flowchart") {
    const shape = /([A-Za-z_\u0590-\u05FF][\w\u0590-\u05FF-]*)\s*(\(\(\(|\(\(|\(\[|\[\[|\[\(|\[\/|\[\\|\(|\[|\{\{|\{|>)\s*("[^"]*"|[^\])}>]*?)\s*(\)\)\)|\)\)|\]\)|\]\]|\)\]|\/\]|\\\]|\)|\]|\}\}|\}|\])/g;
    const ids = new Set<string>();
    for (const line of lines) {
      if (/^(subgraph|end|classDef|class|style|linkStyle|click|direction)\b/.test(line)) {
        const sg = /^subgraph\s+(?:[\w\u0590-\u05FF-]+\s*\[(.+)\]|(.+))$/.exec(line);
        if (sg) nodes.add(unquote(sg[1] ?? sg[2]));
        continue;
      }
      for (const m of line.matchAll(shape)) {
        ids.add(m[1]);
        const label = unquote(m[3]);
        if (label) nodes.add(label);
      }
      for (const m of line.matchAll(/--\s*([^->|][^->]*?)\s*-->|-->\s*\|([^|]+)\||==>\s*\|([^|]+)\||-\.->\s*\|([^|]+)\||---\s*\|([^|]+)\|/g)) {
        const label = unquote(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "");
        if (label) edges.push(label);
      }
      // Bare ids (A --> B) are labelled with themselves.
      const bare = line.replace(shape, "$1").replace(/\|[^|]*\|/g, " ").replace(/--[^->]+-->/g, "-->");
      for (const m of bare.matchAll(/(?:^|[\s&>-])([A-Za-z_\u0590-\u05FF][\w\u0590-\u05FF]*)(?=\s*(?:$|[-=.&]|;))/g)) if (!ids.has(m[1]) && !/^(o|x)$/.test(m[1])) {
        ids.add(m[1]);
        nodes.add(m[1]);
      }
    }
  } else if (kind === "sequence") {
    const aliases = new Map<string, string>();
    for (const line of lines) {
      const p = /^(?:participant|actor)\s+(\S+)(?:\s+as\s+(.+))?$/.exec(line);
      if (p) {
        aliases.set(p[1], unquote(p[2] ?? p[1]));
        nodes.add(unquote(p[2] ?? p[1]));
        continue;
      }
      const msg = /^([^\s:-][^:]*?)\s*(?:-->>|->>|-->|->|--x|-x|--\)|-\))[+-]?\s*([^:]+?)\s*:\s*(.*)$/.exec(line);
      if (msg) {
        for (const who of [msg[1], msg[2]]) {
          const id = who.trim();
          if (!aliases.has(id)) {
            aliases.set(id, id);
            nodes.add(id);
          }
        }
        if (msg[3].trim()) edges.push(unquote(msg[3]));
        continue;
      }
      const note = /^note\s+(?:left of|right of|over)\s+[^:]+:\s*(.+)$/i.exec(line);
      if (note) nodes.add(unquote(note[1]));
    }
  } else if (kind === "class" || kind === "state" || kind === "er") {
    // Each id is shown once, by its label when it has one (`class X["…"]`, `state "…" as X`, `X : …`, `E["…"]`).
    const label = new Map<string, string>();
    const see = (id: string, text?: string) => {
      if (id === "[*]") return;
      if (text !== undefined) label.set(id, text);
      else if (!label.has(id)) label.set(id, id);
    };
    for (const line of lines) {
      if (kind === "class") {
        const c = /^class\s+([\w\u0590-\u05FF]+)(?:\["([^"]+)"\])?/.exec(line);
        if (c) see(c[1], c[2]);
        const rel = /^([\w\u0590-\u05FF]+)\s*(?:"[^"]*"\s*)?(<\|--|\*--|o--|-->|--|\.\.>|\.\.\|>|\.\.|--\|>|--\*|--o)\s*(?:"[^"]*"\s*)?([\w\u0590-\u05FF]+)\s*(?::\s*(.+))?$/.exec(line);
        if (rel) {
          see(rel[1]);
          see(rel[3]);
          if (rel[4]) edges.push(unquote(rel[4]));
        }
      } else if (kind === "state") {
        const desc = /^state\s+"([^"]+)"\s+as\s+(\S+)/.exec(line);
        if (desc) {
          see(desc[2], desc[1]);
          continue;
        }
        const t = /^(\[\*\]|[\w\u0590-\u05FF]+)\s*-->\s*(\[\*\]|[\w\u0590-\u05FF]+)\s*(?::\s*(.+))?$/.exec(line);
        if (t) {
          see(t[1]);
          see(t[2]);
          if (t[3]) edges.push(unquote(t[3]));
          continue;
        }
        const d = /^([\w\u0590-\u05FF]+)\s*:\s*(.+)$/.exec(line);
        if (d) see(d[1], unquote(d[2]));
      } else {
        const rel = /^([\w\u0590-\u05FF-]+)(?:\["([^"]+)"\])?\s+[|}o][|o]?(?:--|\.\.)[|o][|{o]?\s+([\w\u0590-\u05FF-]+)(?:\["([^"]+)"\])?\s*:\s*(.+)$/.exec(line);
        if (rel) {
          see(rel[1], rel[2]);
          see(rel[3], rel[4]);
          edges.push(unquote(rel[5]));
          continue;
        }
        const ent = /^([\w\u0590-\u05FF-]+)(?:\["([^"]+)"\])?\s*\{$/.exec(line);
        if (ent) see(ent[1], ent[2]);
      }
    }
    for (const v of label.values()) nodes.add(v);
  }
  // Labels without letters ("[*]", "-->") aren't texts to look for.
  const keep = (s: string) => /[\p{L}\p{N}]/u.test(s);
  return { nodes: [...nodes].filter(keep), edges: edges.filter(keep) };
}

/** Which expected labels are not among the converted elements' texts (whitespace-insensitive). */
export function missingLabels(expected: { nodes: string[]; edges: string[] }, texts: readonly string[]): string[] {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const have = texts.map(norm);
  return [...expected.nodes, ...expected.edges].filter((l) => !have.some((h) => h === norm(l) || h.includes(norm(l))));
}

/**
 * What can go wrong before the real parse, in the user's terms: no diagram
 * at all, or a type the canvas can't make editable.
 */
export function precheck(code: string): { ok: true; kind: DiagramKind } | { ok: false; reason: "empty" | "unknown" | "not-editable"; kind?: string } {
  if (!code.trim()) return { ok: false, reason: "empty" };
  const kind = diagramKind(code);
  if (kind === null) return { ok: false, reason: "unknown" };
  if (kind === "other") return { ok: false, reason: "not-editable", kind: meaningfulLines(code)[0].split(/\s/)[0] };
  return { ok: true, kind };
}
