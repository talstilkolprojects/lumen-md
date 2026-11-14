/**
 * Which skills there are (plan W7.1): Lumen's starters, the vault's own
 * `.lumen/skills/<name>/SKILL.md`, and skills that plugins bring. A vault
 * skill of the same name replaces a starter (the user's copy wins); a
 * plugin's never replaces either.
 *
 * Trust: starters and the user's own vault are trusted. A plugin's skill,
 * or any skill in a vault someone shared with the user, is untrusted: its
 * first run of each version asks (run.ts). The versions the user allowed
 * are kept per browser (`lumen.skills.allowed`).
 */
import { parseSkill, VAULT_SKILLS_DIR, SKILL_FILE, type Skill, type SkillSource } from "./skillFile";
import { starterSkills } from "./starters";

export interface SkillStore {
  /** Names of the folders directly under `path` (empty when it does not exist). */
  listDirs(path: string): Promise<string[]>;
  read(path: string): Promise<string>;
}

export interface LoadedSkills {
  skills: Skill[];
  /** Files that are not valid skills, with the reason (shown in the list, never run). */
  problems: Array<{ path: string; error: string }>;
}

const plugins = new Map<string, Skill>();

/** A plugin's skill (from its package): always untrusted. */
export function registerPluginSkill(plugin: string, path: string, text: string): { ok: true; skill: Skill } | { ok: false; error: string } {
  const folder = path.split("/").slice(-2, -1)[0];
  const p = parseSkill(text, { kind: "plugin", plugin, path }, folder);
  if (!p.ok) return p;
  plugins.set(`${plugin}/${p.skill.name}`, p.skill);
  return { ok: true, skill: p.skill };
}

export function unregisterPluginSkills(plugin: string): void {
  for (const k of [...plugins.keys()]) if (k.startsWith(`${plugin}/`)) plugins.delete(k);
}

/**
 * Every skill, sorted by name. `sharedFrom`: the vault is someone else's
 * (a shared or collaborative vault), so its skills are untrusted.
 */
export async function loadSkills(store: SkillStore | null, opts: { sharedFrom?: string } = {}): Promise<LoadedSkills> {
  const byName = new Map<string, Skill>();
  for (const s of starterSkills()) byName.set(s.name, s);
  const problems: LoadedSkills["problems"] = [];
  if (store) {
    for (const dir of await store.listDirs(VAULT_SKILLS_DIR).catch(() => [] as string[])) {
      const path = `${VAULT_SKILLS_DIR}/${dir}/${SKILL_FILE}`;
      let text: string;
      try {
        text = await store.read(path);
      } catch {
        continue; // a folder without SKILL.md
      }
      const source: SkillSource = opts.sharedFrom ? { kind: "shared", path, from: opts.sharedFrom } : { kind: "vault", path };
      const p = parseSkill(text, source, dir);
      if (p.ok) byName.set(p.skill.name, p.skill);
      else problems.push({ path, error: p.error });
    }
  }
  for (const s of plugins.values()) if (!byName.has(s.name)) byName.set(s.name, s);
  return { skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), problems };
}

/** Skills whose name or title starts with (then contains) what follows the `/`. */
export function matchSkills(skills: readonly Skill[], query: string): Skill[] {
  const q = query.replace(/^\//, "").trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (!q) return [...skills];
  const hay = (s: Skill) => [s.name, ...Object.entries(s.metadata).filter(([k]) => k.startsWith("title")).map(([, v]) => v)].map((x) => x.toLowerCase());
  const starts = skills.filter((s) => hay(s).some((h) => h.startsWith(q)));
  const contains = skills.filter((s) => !starts.includes(s) && hay(s).some((h) => h.includes(q)));
  return [...starts, ...contains];
}

/** `/name the request` → the skill name and the request. */
export function parseSlash(input: string): { name: string; request: string } | null {
  const m = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/.exec(input.trim());
  return m ? { name: m[1]!, request: (m[2] ?? "").trim() } : null;
}

const ALLOWED_KEY = "lumen.skills.allowed";

/** The untrusted skill versions the user allowed in this browser. */
export function allowedStore(storage: Pick<Storage, "getItem" | "setItem"> | null = typeof localStorage === "undefined" ? null : localStorage) {
  const read = (): string[] => {
    try {
      const v = JSON.parse(storage?.getItem(ALLOWED_KEY) ?? "[]") as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  return {
    has: (fp: string) => read().includes(fp),
    add: (fp: string) => {
      try {
        storage?.setItem(ALLOWED_KEY, JSON.stringify([...new Set([...read(), fp])].slice(-200)));
      } catch {
        // why: storage is blocked or full (private mode, quota): the setting holds for this session only
        /* storage full or blocked: the next run asks again */
      }
    },
  };
}
