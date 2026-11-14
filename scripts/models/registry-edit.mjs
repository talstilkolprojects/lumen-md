/**
 * Edit models/registry.json without reformatting it (plan 6.0): entries are
 * replaced or appended as text, each in the file's style (2-space JSON,
 * one-line string arrays), so a diff shows only what changed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REGISTRY = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."), "models", "registry.json");

/** One entry as the registry writes it: indented 4, arrays of strings on one line, `files` one object per line. */
export function formatEntry(entry) {
  const lines = ["    {"];
  const keys = Object.keys(entry);
  keys.forEach((k, i) => {
    const v = entry[k];
    let text;
    if (k === "files" && Array.isArray(v)) {
      text = `[\n${v.map((f) => `        ${JSON.stringify(f)}`).join(",\n")}\n      ]`;
    } else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      text = `[${v.map((x) => JSON.stringify(x)).join(", ")}]`;
    } else {
      text = JSON.stringify(v);
    }
    lines.push(`      ${JSON.stringify(k)}: ${text}${i < keys.length - 1 ? "," : ""}`);
  });
  lines.push("    }");
  return lines.join("\n");
}

/** Replace (by id) or append entries; set `updated`. Returns the new text. */
export function upsertEntries(text, entries, updated) {
  const parsed = JSON.parse(text);
  let out = text;
  for (const entry of entries) {
    const idx = parsed.models.findIndex((m) => m.id === entry.id);
    const block = formatEntry(entry);
    if (idx >= 0) {
      // The entry's text: from its `"id": "<id>"` line back to its opening brace, forward to its closing brace.
      const idLine = out.indexOf(`"id": ${JSON.stringify(entry.id)}`);
      const start = out.lastIndexOf("    {", idLine);
      const end = out.indexOf("\n    }", idLine) + "\n    }".length;
      out = out.slice(0, start) + block + out.slice(end);
    } else {
      const close = out.lastIndexOf("\n  ]");
      out = out.slice(0, close) + ",\n" + block + out.slice(close);
    }
  }
  if (updated) out = out.replace(/"updated": "[^"]*"/, `"updated": "${updated}"`);
  JSON.parse(out); // still valid
  return out;
}

export function writeEntries(entries, updated) {
  writeFileSync(REGISTRY, upsertEntries(readFileSync(REGISTRY, "utf8"), entries, updated));
}
