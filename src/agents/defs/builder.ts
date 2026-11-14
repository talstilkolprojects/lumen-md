/**
 * builder — `ai.productAgent`'s model steps as agents: the product spec
 * (schema-checked JSON) and each generated file (checked by type: JSON
 * parses, package.json has a name, HTML has a document, nothing is empty
 * or wrapped in fences). The pipeline itself (spec → architecture →
 * files → tests → docs → deploy config) stays in productAgent.ts.
 */

import type { AgentDefinition, AgentInput, ValidationResult } from "../types";
import { registerAgent } from "../registry";
import { pickTools } from "../tools";
import { fail, ok, stripFences } from "./shared";

export interface ProductSpecOut {
  name: string;
  description: string;
  features: string[];
  techStack: string[];
  fileStructure: string[];
}

export interface SpecInput extends AgentInput {
  text: string;
}

const SAFE_PATH = /^(?!\/)(?!.*\.\.)[\w@.\-/]+$/;

export const builderSpecAgent: AgentDefinition<SpecInput, ProductSpecOut> = registerAgent<SpecInput, ProductSpecOut>({
  id: "builder-spec",
  language: "any",
  commandId: "ai.productAgent",
  description: "Turn a product idea into a specification",
  system:
    "You are a senior product architect. Given a product idea, create a specification as a JSON object: " +
    '{"name": "project-name-kebab-case", "description": "one paragraph", "features": ["…"], "techStack": ["…"], ' +
    '"fileStructure": ["index.html", "style.css", "app.js"]}. Use vanilla HTML/CSS/JS unless the idea names a ' +
    "framework; keep it achievable in one workspace; at most 12 files, relative paths, no `..`. Pick a name no " +
    "folder in the list_files result already uses. Output ONLY the JSON.",
  user: (input) => `Product idea: ${input.text}`,
  // What the workspace already holds, so the project's name does not collide (5.3.2).
  tools: pickTools("list_files"),
  context: () => [{ tool: "list_files", args: { limit: 100 } }],
  maxSteps: 3,
  outputSchema: {
    type: "object",
    properties: {
      name: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,60}$" },
      description: { type: "string", minLength: 1 },
      features: { type: "array", items: { type: "string" }, minItems: 1 },
      techStack: { type: "array", items: { type: "string" } },
      fileStructure: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 12 },
    },
    required: ["name", "description", "features", "techStack", "fileStructure"],
  },
  validators: [
    {
      name: "paths",
      check: (out) => {
        const bad = out.fileStructure.filter((p) => !SAFE_PATH.test(p));
        return bad.length ? fail(`unsafe file paths: ${bad.join(", ")}`, "Use relative paths without .. or leading /.") : ok;
      },
    },
  ],
  tier: "medium",
  temperature: 0.4,
  maxTokens: 1200,
});

export interface FileInput extends AgentInput {
  /** The full generation request (product, file, stack, architecture, context). */
  text: string;
  extra: { path: string };
}

/** Per-type sanity checks for a generated file. */
export function checkGeneratedFile(path: string, content: string): ValidationResult {
  if (!content.trim()) return fail("empty file");
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "json") {
    // The whole file must parse — prose around an object is not a JSON file.
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch (e) {
      return fail(`invalid JSON: ${(e as Error).message}`, "Return the complete JSON file only, with no text before or after it.");
    }
    if (/(^|\/)package\.json$/.test(path)) {
      const v = value as Record<string, unknown>;
      if (!v || typeof v !== "object" || typeof v.name !== "string") return fail("package.json needs a string `name`");
    }
  }
  if (ext === "html" && !/<html[\s>]|<!doctype html/i.test(content)) return fail("HTML file without a document", "Return a complete HTML document.");
  return ok;
}

export const builderFileAgent: AgentDefinition<FileInput, string> = registerAgent<FileInput, string>({
  id: "builder-file",
  language: "any",
  commandId: "ai.productAgent",
  description: "Generate one file of a product",
  system:
    "You are an expert full-stack developer. Generate production-quality code for the specified file. Output ONLY " +
    "the file content — no explanation, no code fences.",
  user: (input) => input.text,
  parse: (text) => stripFences(text),
  validators: [{ name: "file", check: (out, input) => checkGeneratedFile((input as FileInput).extra.path, out) }],
  tier: "medium",
  temperature: 0.3,
  maxTokens: 4000,
});
