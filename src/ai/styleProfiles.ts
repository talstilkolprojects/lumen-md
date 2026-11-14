/**
 * Style profiles — the local replacement for fine-tuning.
 *
 * `buildStyleProfile()` samples the user's notes (newest and longest
 * first, a bounded excerpt of each), asks the `stylist` agent for a tone,
 * concrete rules and verbatim examples, and stores the result on this
 * device. While a profile is active, the writing agents (Ghostwriter,
 * prompt templates, rewrite) append it to their system prompt, on any
 * executor. `styleModelfile()` exports it as an Ollama Modelfile so the
 * same voice can be baked into a local model (`ollama create`).
 *
 * OpenAI fine-tuning stays available under the cloud policy until the
 * provider stops accepting new jobs (6 Jan 2027).
 */

export interface StyleProfile {
  tone: string;
  rules: string[];
  examples: string[];
  /** How many notes were sampled. */
  notes: number;
  builtAt: string;
  /** Sampling rules the profile was built with (2: outside notes left out, plan 2.7). */
  sampleV?: number;
}

const KEY = "lumen.ai.styleProfile";
const ACTIVE = "lumen.ai.styleProfile.active";
const EXCERPT_CHARS = 900;
const TOTAL_CHARS = 9000;

/**
 * Plan 2.7: profiles learned before outside notes were left out of the
 * sample (no `sampleV`) may carry someone else's instructions into the
 * writing agents' system prompts, so they are not used: the user rebuilds.
 */
const SAMPLE_VERSION = 2;

export function getStyleProfile(): StyleProfile | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return v && typeof v === "object" && Array.isArray(v.rules) && v.sampleV === SAMPLE_VERSION ? (v as StyleProfile) : null;
  } catch {
    return null;
  }
}

export function styleProfileActive(): boolean {
  try {
    return localStorage.getItem(ACTIVE) === "1" && getStyleProfile() !== null;
  } catch {
    return false;
  }
}

export function setStyleProfileActive(on: boolean): void {
  try {
    if (on) localStorage.setItem(ACTIVE, "1");
    else localStorage.removeItem(ACTIVE);
  } catch {
    /* why: storage denied */
  }
}

export function clearStyleProfile(): void {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(ACTIVE);
  } catch {
    /* why: storage denied */
  }
}

const TABLE_DELIMITER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/**
 * Body text of a note — what a writing style can be learned from: no
 * frontmatter, fenced code (``` or ~~~), tables (with or without outer
 * pipes), image-only lines.
 */
export function proseOfNote(text: string): string {
  const lines = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      continue;
    }
    if (m) {
      fence = m[1];
      continue;
    }
    // A GFM table: a header row with a pipe, then a delimiter row; rows follow while they have a pipe.
    if (line.includes("|") && i + 1 < lines.length && TABLE_DELIMITER.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) i++;
      i--;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) || /^\s*!\[.*\]\(.*\)\s*$/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Excerpts for the stylist: longest notes first, a slice of each, bounded overall. */
export function sampleExcerpts(notes: ReadonlyArray<{ path: string; text: string }>): { text: string; count: number } {
  const prose = notes
    .map((n) => proseOfNote(n.text))
    .filter((p) => p.length >= 200)
    .sort((a, b) => b.length - a.length);
  const parts: string[] = [];
  let total = 0;
  for (const p of prose) {
    const slice = p.slice(0, EXCERPT_CHARS);
    if (total + slice.length > TOTAL_CHARS) break;
    parts.push(slice);
    total += slice.length;
  }
  return { text: parts.join("\n---\n"), count: parts.length };
}

/** At most this many notes are read to learn a style from. */
const MAX_NOTES = 300;

export async function buildStyleProfile(prefix = "", signal?: AbortSignal): Promise<StyleProfile> {
  // The notes are read through the agent runtime's tools (list_files +
  // read_file, plan 5.3.3), under the same rules as the agent's own calls.
  const { callTool } = await import("../agents/runtime");
  // Plan 2.7: a style profile is the user's own voice, and it is saved and
  // later put into writing agents' system prompts — so outside notes
  // (clipped, imported, pulled from git) never go into the sample.
  const { ensureProvenanceBackfill, untrustedSourcesOfNote } = await import("../agents/provenance");
  await ensureProvenanceBackfill();
  const folder = prefix.replace(/\/+$/, "");
  const { files } = await callTool<{ files: string[] }>("list_files", { ...(folder ? { prefix: `${folder}/` } : {}), limit: MAX_NOTES }, { signal });
  const notes: Array<{ path: string; text: string }> = [];
  for (let i = 0; i < files.length; i += 8) {
    const batch = await Promise.all(
      files.slice(i, i + 8).map((path) =>
        callTool<{ content: string }>("read_file", { path }, { signal }).then(
          (r) => ({ path, text: r.content }),
          () => null, // unreadable: skipped, like before
        ),
      ),
    );
    for (const n of batch) if (n && !untrustedSourcesOfNote(n.path, n.text).length) notes.push(n);
  }
  const sample = sampleExcerpts(notes);
  if (sample.count < 2) throw new Error("Not enough writing to learn a style from: pick a folder with at least two notes of a few paragraphs.");
  const { runAgentOrThrow } = await import("../agents/runtime");
  const { stylistAgent } = await import("../agents/defs");
  const out = await runAgentOrThrow(stylistAgent, { text: sample.text }, { signal });
  const flat = sample.text.replace(/\s+/g, " ");
  const profile: StyleProfile = {
    tone: out.tone.trim(),
    rules: out.rules.map((r) => r.trim()).filter(Boolean).slice(0, 10),
    examples: out.examples.filter((e) => flat.includes(e.replace(/\s+/g, " ").trim())).slice(0, 5),
    notes: sample.count,
    builtAt: new Date().toISOString(),
    sampleV: SAMPLE_VERSION,
  };
  localStorage.setItem(KEY, JSON.stringify(profile));
  setStyleProfileActive(true);
  return profile;
}

/** The system-prompt addendum the writing agents use while a profile is active. */
export function styleInstruction(profile: StyleProfile | null = styleProfileActive() ? getStyleProfile() : null): string {
  if (!profile) return "";
  return [
    "Write in the user's own style.",
    `Tone: ${profile.tone}`,
    "Rules:",
    ...profile.rules.map((r) => `- ${r}`),
    profile.examples.length ? "Examples of their writing:" : "",
    ...profile.examples.map((e) => `> ${e}`),
  ]
    .filter(Boolean)
    .join("\n");
}

/** An Ollama Modelfile that bakes the profile into a local model. */
export function styleModelfile(baseModel: string, profile: StyleProfile | null = getStyleProfile()): string {
  if (!profile) throw new Error("No style profile yet.");
  const system = styleInstruction(profile).replace(/"""/g, '"\\"\\"');
  return `# Lumen style profile (${profile.builtAt}, ${profile.notes} notes)\n# ollama create my-style -f lumen-style.Modelfile\nFROM ${baseModel}\nPARAMETER temperature 0.6\nSYSTEM """\n${system}\n"""\n`;
}
