/**
 * autofiller (plan 5.10) — proposes values for a note's missing
 * properties, from the note and the properties the vault already uses.
 * The answer is constrained by a JSON Schema built for the request (each
 * property's type, and the vault's values when they are a closed set);
 * the runtime checks the generic shape, the validator the request's
 * schema. It never writes: the caller turns the answer into a proposal
 * for the approval queue (src/properties/autofill.ts).
 */

import type { AgentDefinition, AgentInput, JsonSchema } from "../types";
import { registerAgent } from "../registry";
import { clip, fail, ok } from "./shared";
import { formatSchemaErrors, validateSchema } from "../schema";
import type { FieldSpec } from "../../properties/autofill";

export interface AutofillerInput extends AgentInput {
  /** The note. */
  text: string;
  extra: { fields: FieldSpec[]; schema: JsonSchema };
}

export interface AutofillerOutput {
  values: Record<string, unknown>;
}

function describeField(f: FieldSpec): string {
  const kind = f.type === "list" ? "list of strings" : f.type === "checkbox" ? "true/false" : f.type === "date" ? "date YYYY-MM-DD" : f.type;
  return `- ${f.key} (${kind})${f.options ? `: one of ${f.options.map((o) => JSON.stringify(o)).join(", ")}` : ""}`;
}

export const autofillerAgent: AgentDefinition<AutofillerInput, AutofillerOutput> = registerAgent<AutofillerInput, AutofillerOutput>({
  id: "autofiller",
  commandId: "ai.autofill",
  description: "Propose values for a note's properties (approved before anything is written)",
  system: (input) =>
    "You fill in metadata properties of a Markdown note from what the note says. Properties:\n" +
    input.extra.fields.map(describeField).join("\n") +
    "\nGive a value only when the note supports it; leave a property out when it doesn't. Use the listed values exactly when a property has them. " +
    "Write text in the note's language. Output ONLY JSON matching this schema: " +
    JSON.stringify(input.extra.schema),
  user: (input) => clip(input.text, 6000),
  outputSchema: { type: "object", properties: { values: { type: "object" } }, required: ["values"] },
  validators: [
    {
      name: "schema",
      check: (out, input) => {
        const errors = validateSchema(out, (input as AutofillerInput).extra.schema);
        return errors.length ? fail(`does not match the properties' schema: ${formatSchemaErrors(errors)}`, "Use only the listed properties, with values of their type.") : ok;
      },
    },
  ],
  language: "any",
  maxRetries: 1,
  tier: "small",
  temperature: 0,
  maxTokens: 600,
});
