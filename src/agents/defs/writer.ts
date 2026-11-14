/**
 * writer / templater — the interactive writing commands: the WYSIWYG
 * "AI Ghostwriter" (streamed into the document) and the `ai.prompt.*`
 * templates. No retries (the user is watching the text arrive); the only
 * check is that something came back.
 */

import type { AgentDefinition, AgentInput } from "../types";
import { registerAgent } from "../registry";
import { pickTools } from "../tools";
import { nonEmptyValidator } from "../tools/validate";
import { clip } from "./shared";
import { styleInstruction } from "../../ai/styleProfiles";
import { AI_PROMPT_TEMPLATES } from "../../ai/multiLangPrompts";

export interface WriterInput extends AgentInput {
  /** What to write. */
  text: string;
}

export const writerAgent: AgentDefinition<WriterInput, string> = registerAgent<WriterInput, string>({
  id: "writer",
  description: "Write Markdown from a request (Ghostwriter)",
  system: () =>
    [
      "You are a helpful ghostwriter embedded inside a markdown editor. Write in the language of the request. " +
        "Provide just the raw markdown response without surrounding code fences unless the user requested code.",
      styleInstruction(),
    ]
      .filter(Boolean)
      .join("\n\n"),
  user: (input) => clip(input.text, 8000),
  // Streaming: the selection comes as a context call, not a model tool turn (5.3.2).
  tools: pickTools("get_selection"),
  context: () => [{ tool: "get_selection" }],
  maxSteps: 2,
  validators: [nonEmptyValidator()],
  streaming: true,
  maxRetries: 0,
  tier: "small",
  temperature: 0.7,
  maxTokens: 1500,
});

export interface TemplaterInput extends AgentInput {
  /** The template already applied to the document (multiLangPrompts.applyTemplate). */
  text: string;
  extra: { templateId: string };
}

export const templaterAgent: AgentDefinition<TemplaterInput, string> = registerAgent<TemplaterInput, string>({
  id: "templater",
  description: "Run a prompt template (summarize, improve, explain…) on the document",
  system: () =>
    ["You are a writing assistant inside a Markdown editor. Follow the instruction exactly and answer in Markdown, in the language the instruction asks for.", styleInstruction()]
      .filter(Boolean)
      .join("\n\n"),
  // The whole template input goes out, as before the agents: improve /
  // translate / summarize must see the complete document.
  user: (input) => input.text,
  tools: pickTools("get_selection"),
  context: () => [{ tool: "get_selection" }],
  maxSteps: 2,
  // A translation template names its own target language: the answer is
  // not in the document's language, so neither the prompt nor the check
  // may demand that.
  language: (input) => (AI_PROMPT_TEMPLATES.find((t) => t.id === input.extra?.templateId)?.category === "translation" ? "any" : "input"),
  validators: [nonEmptyValidator()],
  streaming: true,
  // Streamed text is already in front of the user: a retry would duplicate it.
  maxRetries: 0,
  tier: "medium",
  temperature: 0.5,
  maxTokens: 2000,
});
