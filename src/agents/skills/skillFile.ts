/**
 * Agent Skills as files (plan W7.1): `<vault>/.lumen/skills/<name>/SKILL.md`
 * in the open Agent Skills format (https://agentskills.io/specification),
 * so the same folder works in Claude Code and Codex.
 *
 *   ---
 *   name: sort-inbox                 # lowercase, digits, single hyphens; ≤ 64; = the folder
 *   description: What it does and when to use it.   # ≤ 1024
 *   allowed-tools: list_files read_file set_frontmatter   # space-separated (or a YAML list)
 *   metadata:                        # string → string (optional)
 *     title-he: מיין את ה-inbox
 *   ---
 *   Instructions in Markdown.
 *
 * `allowed-tools` names Lumen's agent tools; Claude Code's names (Read,
 * Write, Edit, Grep, Glob) map to them. Anything else (Bash, WebFetch …)
 * is not granted, and the skill is told so: a skill gets only the tools it
 * declares, never more.
 */
import YAML from "yaml";

export const SKILL_FILE = "SKILL.md";
export const VAULT_SKILLS_DIR = ".lumen/skills";
export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_NAME = 64;
export const MAX_DESCRIPTION = 1024;

/** Where a skill came from. Only the user's own vault and Lumen's starters are trusted (plan 2.7). */
export type SkillSource = { kind: "starter" } | { kind: "vault"; path: string } | { kind: "plugin"; plugin: string; path: string } | { kind: "shared"; path: string; from: string };

export interface Skill {
  name: string;
  description: string;
  /** The tool names the file declares, as written. */
  allowedTools: string[];
  metadata: Record<string, string>;
  license?: string;
  /** The Markdown after the frontmatter: the instructions. */
  body: string;
  source: SkillSource;
}

export type ParsedSkill = { ok: true; skill: Skill; warnings: string[] } | { ok: false; error: string };

/** Claude Code / Codex tool names → Lumen agent tools (src/agents/tools). */
export const TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  Read: ["read_file", "get_frontmatter"],
  Write: ["write_file"],
  Edit: ["write_file", "set_frontmatter"],
  Grep: ["search_workspace"],
  Glob: ["list_files"],
};

function splitFrontmatter(text: string): { yaml: string; body: string } | null {
  const t = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!t.startsWith("---\n")) return null;
  const end = t.indexOf("\n---", 4);
  if (end < 0) return null;
  const after = t.indexOf("\n", end + 4);
  return { yaml: t.slice(4, end), body: after < 0 ? "" : t.slice(after + 1) };
}

/** The declared tools: a space-separated string (the spec) or a YAML list; `Bash(git:*)` keeps `Bash`. */
export function readAllowedTools(v: unknown): string[] {
  const list = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/[\s,]+/) : [];
  const out: string[] = [];
  for (const raw of list) {
    const name = raw.trim().replace(/\(.*\)$/, "");
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Parse and check a SKILL.md. `folder`: its folder's name, which must equal `name`. */
export function parseSkill(text: string, source: SkillSource, folder?: string): ParsedSkill {
  const parts = splitFrontmatter(text);
  if (!parts) return { ok: false, error: "SKILL.md must start with YAML frontmatter between --- lines" };
  let data: unknown;
  try {
    data = YAML.parse(parts.yaml);
  } catch (e) {
    return { ok: false, error: `frontmatter is not valid YAML: ${(e as Error).message}` };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: "frontmatter must be a map" };
  const d = data as Record<string, unknown>;
  const name = typeof d.name === "string" ? d.name.trim() : "";
  if (!name || name.length > MAX_NAME || !NAME_RE.test(name)) return { ok: false, error: `name must be 1–${MAX_NAME} lowercase letters, digits and single hyphens` };
  if (folder !== undefined && folder !== name) return { ok: false, error: `name "${name}" must match its folder "${folder}"` };
  const description = typeof d.description === "string" ? d.description.trim() : "";
  if (!description || description.length > MAX_DESCRIPTION) return { ok: false, error: `description is required (≤ ${MAX_DESCRIPTION} characters)` };
  const metadata: Record<string, string> = {};
  if (d.metadata && typeof d.metadata === "object" && !Array.isArray(d.metadata)) {
    for (const [k, v] of Object.entries(d.metadata as Record<string, unknown>)) if (typeof v === "string" || typeof v === "number") metadata[k] = String(v);
  }
  const warnings: string[] = [];
  const allowedTools = readAllowedTools(d["allowed-tools"]);
  for (const k of Object.keys(d)) if (!["name", "description", "license", "compatibility", "metadata", "allowed-tools"].includes(k)) warnings.push(`unknown frontmatter field "${k}"`);
  return {
    ok: true,
    skill: { name, description, allowedTools, metadata, ...(typeof d.license === "string" ? { license: d.license } : {}), body: parts.body.trim(), source },
    warnings,
  };
}

/**
 * A skill runs without asking only when it is one of Lumen's starters. A
 * vault skill may have come with a shared folder, a git clone or a download
 * (review 21, D1): it asks once per version, on this device.
 */
export function isTrusted(source: SkillSource): boolean {
  return source.kind === "starter";
}

/** Outside skills (a plugin's, a shared vault's): guarded and tainted on every run, even after the first-run approval. */
export function isOutside(source: SkillSource): boolean {
  return source.kind === "plugin" || source.kind === "shared";
}

export function sourceLabel(source: SkillSource): string {
  switch (source.kind) {
    case "starter":
      return "skill: Lumen starter";
    case "vault":
      return `skill: ${source.path}`;
    case "plugin":
      return `skill from plugin ${source.plugin}: ${source.path}`;
    case "shared":
      return `skill from shared vault ${source.from}: ${source.path}`;
  }
}

/** The title to show: metadata title in the UI language, else the name. */
export function skillTitle(skill: Skill, locale: string): string {
  return skill.metadata[`title-${locale.slice(0, 2)}`] ?? skill.metadata.title ?? skill.name;
}

/** SHA-256 of everything that reaches the model (name, description, tools, body): a trust decision is for this exact version (review 21, D2). */
export async function skillFingerprint(skill: Skill): Promise<string> {
  const s = JSON.stringify([skill.name, skill.description, skill.allowedTools, skill.metadata, skill.body]);
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
