/**
 * The palette builds the prompt-template commands from AI_PROMPT_INDEX at
 * startup and loads the prompts with the command: the index must list
 * exactly the templates, with the same id, label, language and category.
 */
import { describe, it, expect } from "vitest";
import { AI_PROMPT_INDEX } from "../ai/multiLangPromptIndex";
import { AI_PROMPT_TEMPLATES } from "../ai/multiLangPrompts";

describe("AI prompt template index", () => {
  it("matches the templates, without their prompts", () => {
    expect(AI_PROMPT_INDEX).toEqual(AI_PROMPT_TEMPLATES.map(({ id, label, lang, category }) => ({ id, label, lang, category })));
  });
});
