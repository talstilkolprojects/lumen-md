/**
 * committer — `git.commit`. One conventional-commit subject line from the
 * repository's change list. Light model; the parser takes the first
 * line that starts with a conventional type (skipping any preamble), and
 * the validator requires one.
 */

import type { AgentDefinition, AgentInput } from "../types";
import { registerAgent } from "../registry";
import { pickTools } from "../tools";
import { fail, ok, stripFences } from "./shared";

export interface CommitterInput extends AgentInput {
  /** `STATE: path` lines, one per changed file (optionally with a diff summary). */
  text: string;
  /** The repository (workspace folder) whose diff the runtime fetches with git_diff; `staged`: the index, not the working copy. */
  extra?: { repo?: string; staged?: boolean };
}

export const CONVENTIONAL = /^(feat|fix|docs|chore|refactor|test|perf|style|build|ci|revert)(\([^)\s]+\))?!?: \S/;

/**
 * The subject line: the first line in conventional-commit form (else the
 * first non-empty line), without quotes/backticks or a trailing period,
 * trimmed to 72 chars.
 */
export function cleanSubject(text: string): string {
  const lines = stripFences(text)
    .split("\n")
    .map((l) => l.trim().replace(/^["'`]+|["'`]+$/g, "").trim())
    .filter((l) => l.length > 0);
  const subject = lines.find((l) => CONVENTIONAL.test(l)) ?? lines[0] ?? "";
  return subject.replace(/\.+$/, "").slice(0, 72).trim();
}

/**
 * Subject and body (5.3.2): the cleaned conventional subject, then — when
 * the model gave one — a blank line and at most four short body lines
 * (what changed and why), without fences, bullets' clutter or a repeat of
 * the subject.
 */
export function commitMessage(text: string): string {
  const subject = cleanSubject(text);
  const lines = stripFences(text).split("\n").map((l) => l.trimEnd());
  const at = lines.findIndex((l) => l.trim().replace(/^["'`]+|["'`]+$/g, "").replace(/\.+$/, "").slice(0, 72).trim() === subject);
  const body = lines
    .slice(at + 1)
    .map((l) => l.trim())
    .filter((l) => l && !CONVENTIONAL.test(l))
    .slice(0, 4)
    .map((l) => (l.length > 100 ? `${l.slice(0, 99)}…` : l));
  return body.length ? `${subject}\n\n${body.join("\n")}` : subject;
}

export const committerAgent: AgentDefinition<CommitterInput, string> = registerAgent({
  id: "committer",
  language: "any",
  commandId: "git.commit",
  description: "Write a conventional commit message (subject and a short body)",
  system:
    "You are a Git commit message generator. Based on the changed files and the diff (the git_diff result), output a " +
    "commit message: first ONE subject line in conventional-commit format (feat:, fix:, docs:, chore:, refactor:, test:), " +
    "imperative mood, at most 72 characters, no trailing period; then, when the diff warrants it, a blank line and 1 to 4 " +
    "short lines saying what changed and why. No quotes, no code fences, no explanation around it.",
  user: (input) => `Changes:\n${input.text.slice(0, 6000)}`,
  tools: pickTools("git_diff"),
  // The diff itself, through the runtime (5.3.2): the subject names what changed, not only which files.
  context: (input) => (input.extra?.repo ? [{ tool: "git_diff", args: { repo: input.extra.repo, staged: !!input.extra.staged, maxChars: 6000 } }] : []),
  maxSteps: 3,
  parse: (text) => commitMessage(text),
  validators: [
    {
      name: "subject",
      check: (out) =>
        CONVENTIONAL.test(out.split("\n")[0]) && out.split("\n")[0].length >= 8
          ? ok
          : fail("not a conventional-commit subject", "Answer with one line like `feat: add X` or `fix(scope): correct Y`, nothing else."),
    },
  ],
  tier: "tiny",
  temperature: 0.2,
  maxTokens: 40,
  maxRetries: 1,
});
