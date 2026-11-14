/**
 * Running a skill (plan W7.1) through the agent runtime (plan 5.3).
 *
 *   • Tools: exactly the ones the skill declares (`allowed-tools`, mapped
 *     by skillFile.ts). The runtime refuses any other call ("Unknown
 *     tool"), and the run is granted only the scopes of those tools.
 *   • Writes: write tools only stage a change; it waits in the review
 *     screen (plan 5.11). Nothing is written to the vault by a run.
 *   • Untrusted skills (from a plugin or a shared vault): the first run of
 *     each version asks the user (`confirmFirstRun`), the instructions pass
 *     the injection guard (plan 2.7), and the run is tainted — every write
 *     or network call it makes needs the user's approval.
 */
import type { AgentDefinition, AgentInput, AgentRun, AgentTool, RunOptions, ToolScope } from "../types";
import { runAgent } from "../runtime";
import { WORKSPACE_TOOLS } from "../tools/workspace";
import { EDITOR_TOOLS } from "../tools/editor";
import { VALIDATE_TOOLS } from "../tools/validate";
import { isTrusted, skillFingerprint, sourceLabel, TOOL_ALIASES, type Skill } from "./skillFile";

/**
 * The tools a skill may declare: the vault's and the open note's, and the
 * validators. Network, Python and git tools are not offered to skills in
 * this version: a skill — possibly someone else's — never reaches the
 * internet or runs code (decision in the W7.1 PR).
 */
export const SKILL_TOOLS: readonly AgentTool[] = [...WORKSPACE_TOOLS, ...EDITOR_TOOLS, ...VALIDATE_TOOLS] as AgentTool[];
const getTool = (name: string) => SKILL_TOOLS.find((t) => t.name === name);

export interface ResolvedTools {
  tools: AgentTool[];
  /** Declared names that are not Lumen tools (not granted). */
  unknown: string[];
}

/** The skill's declared tools as Lumen tools; unknown names are left out. */
export function resolveSkillTools(declared: readonly string[]): ResolvedTools {
  const tools: AgentTool[] = [];
  const unknown: string[] = [];
  const add = (t: AgentTool | undefined) => {
    if (t && !tools.includes(t)) tools.push(t);
  };
  for (const name of declared) {
    const direct = getTool(name);
    if (direct) add(direct);
    else if (TOOL_ALIASES[name]) for (const n of TOOL_ALIASES[name]!) add(getTool(n));
    else unknown.push(name);
  }
  return { tools, unknown };
}

export interface SkillInput extends AgentInput {
  /** What the user typed after `/name`. */
  text: string;
}

export const SKILL_RULES =
  "You are running a Lumen skill: follow its instructions below. Use only the tools you are given; there are no others. " +
  "Changes to notes are proposals the user reviews before anything is written. Answer in the language of the user's notes unless the skill says otherwise.";

/** The agent definition the runtime runs for a skill. */
export function skillAgent(skill: Skill, guarded?: string): AgentDefinition<SkillInput, string> {
  const { tools, unknown } = resolveSkillTools(skill.allowedTools);
  const trusted = isTrusted(skill.source);
  // An untrusted skill's instructions only ever reach the model through the injection guard (runSkill).
  if (!trusted && guarded === undefined) throw new SkillRefusedError(`skill "${skill.name}" is untrusted: its instructions must pass the injection guard`);
  const instructions = trusted ? skill.body : guarded!;
  const missing = unknown.length ? `\nThese tools the skill names are not available here and must not be assumed: ${unknown.join(", ")}.` : "";
  const scopes = [...new Set(tools.map((t) => t.scope).filter((s): s is Exclude<ToolScope, "read"> => s !== "read"))];
  return {
    id: `skill:${skill.name}`,
    description: skill.description,
    system: `${SKILL_RULES}${missing}\n\n# Skill: ${skill.name}\n${skill.description}\n\n${instructions}`,
    user: (input) => input.text || "Run the skill.",
    tools,
    requires: scopes,
    maxSteps: 12,
    maxRetries: 0,
    temperature: 0.2,
    language: "input",
  };
}

export class SkillRefusedError extends Error {}

export interface RunSkillOptions extends RunOptions {
  /** Asked before the first run of an untrusted skill's version; false refuses the run. */
  confirmFirstRun?: (skill: Skill, fingerprint: string) => boolean | Promise<boolean>;
  /** Fingerprints the user already allowed. */
  allowed?: { has(fp: string): boolean; add(fp: string): void };
}

/** Run a skill on the user's request. Untrusted skills ask first and run tainted. */
export async function runSkill(skill: Skill, input: SkillInput, opts: RunSkillOptions = {}): Promise<AgentRun<string>> {
  const trusted = isTrusted(skill.source);
  if (!trusted) {
    const fp = skillFingerprint(skill);
    if (!opts.allowed?.has(fp)) {
      const ok = opts.confirmFirstRun ? await opts.confirmFirstRun(skill, fp) : false;
      if (!ok) throw new SkillRefusedError(`skill "${skill.name}" was not allowed to run`);
      opts.allowed?.add(fp);
    }
  }
  // The guard loads on demand, as in the runtime (agents/untrusted.ts carries its strings).
  const guarded = trusted ? undefined : (await import("../untrusted")).guardUntrusted(skill.body, [sourceLabel(skill.source)]).text;
  const def = skillAgent(skill, guarded);
  const { confirmFirstRun: _c, allowed: _a, ...run } = opts;
  void _c;
  void _a;
  return runAgent(def, input, {
    ...run,
    grants: (def.requires ?? []) as ToolScope[],
    ...(trusted ? {} : { untrusted: [...(run.untrusted ?? []), sourceLabel(skill.source)] }),
  });
}
