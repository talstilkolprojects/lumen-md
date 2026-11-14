/**
 * tasker — `ai.actionItems`. Turns meeting notes into a Markdown task
 * list. Text output; every non-blank line must be an unchecked `- [ ]`
 * item, so a preamble or explanation is retried rather than inserted.
 */

import type { AgentDefinition, AgentInput, ValidationResult } from "../types";
import { registerAgent } from "../registry";
import { pickTools } from "../tools";
import { clip, fail, ok, stripFences } from "./shared";

export interface TaskerInput extends AgentInput {
  text: string;
}

const TASK_LINE = /^\s*[-*]\s+\[ \]\s+\S/;

/** Every non-blank line is an unchecked task item. */
export function checkTaskList(out: string): ValidationResult {
  const lines = out.split("\n").filter((l) => l.trim());
  if (!lines.length) return fail("empty task list", "Return Markdown task list lines only.");
  const bad = lines.find((l) => !TASK_LINE.test(l));
  return bad === undefined ? ok : fail(`not a "- [ ]" task line: ${bad.trim().slice(0, 80)}`, "Return only unchecked task lines (`- [ ] item`), with no preamble or explanation.");
}

export const taskerAgent: AgentDefinition<TaskerInput, string> = registerAgent({
  id: "tasker",
  splittable: true,
  commandId: "ai.actionItems",
  description: "Extract action items from notes as a task list",
  system:
    "You extract action items from meeting notes. Output ONLY a Markdown task list (`- [ ] item`), one item per " +
    "line, each with an owner in parentheses when identifiable and a due date when stated. No headings, no " +
    "preamble, no explanation. Keep the notes' language. If there are no action items, output exactly: - [ ] (none)",
  user: (input) => clip(input.text, 12000),
  parse: (text) => stripFences(text),
  validators: [{ name: "task-list", check: (out) => checkTaskList(out) }],
  // The whole note, when the text given is only part of it (5.3.1, 5.3.3).
  tools: pickTools("get_document"),
  maxSteps: 3,
  tier: "small",
  temperature: 0.1,
  maxTokens: 800,
  cache: true,
});
