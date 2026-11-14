/**
 * Product Agent — AI-powered product creation from zero to production.
 *
 * This agent orchestrates a multi-step pipeline that takes a high-level
 * product idea and generates a complete, working product:
 *
 *   Idea → Spec → Architecture → Code → Tests → Documentation → Deploy config
 *
 * Works with any configured LLM provider (OpenAI, Ollama, WebGPU).
 */

import type { ChatMessage } from "./llm";
import { isOPFSAvailable } from "../storage/workspace";
import { log } from "../lib/logger";

/* ─── Types ───────────────────────────────────────────────────────── */

export type AgentPhase =
  | "idle"
  | "understanding"
  | "planning"
  | "architecting"
  | "coding"
  | "testing"
  | "documenting"
  | "deploying"
  | "complete"
  | "error";

export interface AgentStep {
  phase: AgentPhase;
  description: string;
  status: "pending" | "running" | "done" | "error";
  output?: string;
  files?: string[];
  error?: string;
}

export interface ProductSpec {
  name: string;
  description: string;
  features: string[];
  techStack: string[];
  fileStructure: string[];
}

export interface AgentProgress {
  phase: AgentPhase;
  step: number;
  totalSteps: number;
  message: string;
  files: string[];
}

export type AgentProgressCallback = (progress: AgentProgress) => void;

/* ─── System Prompts ──────────────────────────────────────────────── */

const ARCHITECTURE_PROMPT = `You are a senior software architect. Given a product spec, design the architecture.

Create a detailed markdown document covering:
1. **System Overview** — how components connect
2. **Data Flow** — how data moves through the system
3. **Component Design** — each module's responsibility
4. **API Design** — endpoints/interfaces between components
5. **State Management** — how state is handled
6. **Error Handling Strategy**

Be specific and practical. This document will guide code generation.
Output ONLY the markdown document.`;

const CODE_GEN_PROMPT = `You are an expert full-stack developer. Generate production-quality code for the specified file.

Context: You are building a product according to the architecture document provided.

Rules:
- Write clean, modern, well-structured code
- Use ES modules (import/export)
- Include proper error handling
- Add minimal JSDoc for public functions only
- Make it actually work — no placeholders or TODOs
- Use semantic HTML5 and modern CSS (custom properties, flexbox/grid)
- For JS: use async/await, proper event handling, modular design
- Output ONLY the file content, no explanation`;

const TEST_GEN_PROMPT = `You are a QA engineer. Generate tests for the given source file.

Rules:
- Write unit tests that actually test behavior
- Cover happy path and edge cases
- Use simple assertions (no framework needed — just console.assert or a minimal test runner)
- For HTML: generate a simple test that checks DOM rendering
- Output ONLY the test file content`;

const DOCS_PROMPT = `You are a technical writer. Generate a README.md for this product.

Include:
1. Project title and description
2. Features list
3. Quick start instructions
4. Usage examples
5. File structure overview
6. How to customize/extend

Make it friendly, clear, and useful. Output ONLY the markdown.`;

/* ─── Product Agent ───────────────────────────────────────────��───── */

export class ProductAgent {
  private steps: AgentStep[] = [];
  private spec: ProductSpec | null = null;
  private architecture = "";
  private generatedFiles: Map<string, string> = new Map();
  private abortController: AbortController | null = null;
  private onProgress: AgentProgressCallback | null = null;

  constructor(private projectDir = "") {}

  setProgressCallback(cb: AgentProgressCallback): void {
    this.onProgress = cb;
  }

  getSteps(): AgentStep[] {
    return [...this.steps];
  }

  abort(): void {
    this.abortController?.abort();
  }

  private emit(phase: AgentPhase, message: string): void {
    this.onProgress?.({
      phase,
      step: this.steps.filter((s) => s.status === "done").length,
      totalSteps: this.steps.length || 6,
      message,
      files: [...this.generatedFiles.keys()],
    });
  }

  /**
   * Main entry point — takes an idea and produces a full product.
   */
  async run(idea: string, outer?: AbortSignal): Promise<{ success: boolean; files: Map<string, string>; error?: string }> {
    const ctrl = (this.abortController = new AbortController());
    const signal = ctrl.signal;
    // The caller's cancellation (Esc / "AI: Cancel", T55) stops the run too.
    if (outer?.aborted) ctrl.abort(outer.reason);
    else outer?.addEventListener("abort", () => ctrl.abort(outer.reason), { once: true });
    this.generatedFiles.clear();

    try {
      // Phase 1: Understanding & Specification
      this.emit("understanding", "Analyzing your product idea...");
      this.spec = await this.generateSpec(idea, signal);
      this.emit("planning", `Product: ${this.spec.name} — ${this.spec.features.length} features planned`);

      // Phase 2: Architecture
      this.emit("architecting", "Designing system architecture...");
      this.architecture = await this.generateArchitecture(signal);
      await this.saveFile(`${this.spec.name}/ARCHITECTURE.md`, this.architecture);

      // Phase 3: Code Generation
      this.emit("coding", `Generating ${this.spec.fileStructure.length} files...`);
      for (const filePath of this.spec.fileStructure) {
        if (signal.aborted) throw new Error("Aborted");
        this.emit("coding", `Writing ${filePath}...`);
        const code = await this.generateFile(filePath, signal);
        await this.saveFile(`${this.spec.name}/${filePath}`, code);
      }

      // Phase 4: Tests
      this.emit("testing", "Generating tests...");
      const testableFiles = this.spec.fileStructure.filter(
        (f) => f.endsWith(".js") || f.endsWith(".ts"),
      );
      for (const filePath of testableFiles.slice(0, 5)) {
        if (signal.aborted) throw new Error("Aborted");
        const code = this.generatedFiles.get(`${this.spec.name}/${filePath}`) ?? "";
        const testCode = await this.generateTest(filePath, code, signal);
        await this.saveFile(`${this.spec.name}/tests/${filePath.replace(/\.\w+$/, ".test.js")}`, testCode);
      }

      // Phase 5: Documentation
      this.emit("documenting", "Writing documentation...");
      const readme = await this.generateDocs(signal);
      await this.saveFile(`${this.spec.name}/README.md`, readme);

      // Phase 6: Deploy config
      this.emit("deploying", "Creating deployment configuration...");
      await this.generateDeployConfig(signal);

      // All or nothing (plan 5.3.2): only a finished product reaches the workspace.
      await this.writeAll(signal);
      this.emit("complete", `Product "${this.spec.name}" created with ${this.generatedFiles.size} files!`);
      return { success: true, files: this.generatedFiles };

    } catch (e) {
      // Cancelled by the caller: an AbortError, not a failed product.
      if (outer?.aborted) throw new DOMException("Cancelled by the user", "AbortError");
      const msg = e instanceof Error ? e.message : "Unknown error";
      this.emit("error", msg);
      return { success: false, files: this.generatedFiles, error: msg };
    }
  }

  /**
   * Stream the generation process, yielding status updates.
   */
  async *runStreaming(idea: string): AsyncGenerator<AgentProgress, void, undefined> {
    const updates: AgentProgress[] = [];
    this.setProgressCallback((p) => updates.push(p));

    const resultPromise = this.run(idea);

    while (true) {
      while (updates.length > 0) {
        yield updates.shift()!;
      }
      await new Promise((r) => setTimeout(r, 100));

      const done = await Promise.race([
        resultPromise.then(() => true),
        new Promise<false>((r) => setTimeout(() => r(false), 50)),
      ]);

      while (updates.length > 0) {
        yield updates.shift()!;
      }

      if (done) break;
    }
  }

  /* ─── Internal Generation Steps ─────────────────────────────────── */

  private async generateSpec(idea: string, signal: AbortSignal): Promise<ProductSpec> {
    // The `builder-spec` agent: schema-checked JSON, safe relative paths,
    // retried with the validator's reason by the runtime.
    const { runAgentOrThrow } = await import("../agents/runtime");
    const { builderSpecAgent } = await import("../agents/defs");
    return runAgentOrThrow(builderSpecAgent, { text: idea }, { signal });
  }

  /** A text stage of the build through its agent (plan 5.5): the runtime, local first, traced. */
  private async stage(agent: "builderArchAgent" | "builderTestAgent" | "builderDocsAgent", system: string, text: string, signal: AbortSignal): Promise<string> {
    const [{ runAgentOrThrow }, defs] = await Promise.all([import("../agents/runtime"), import("../agents/defs")]);
    return runAgentOrThrow(defs[agent], { text, extra: { system } }, { signal });
  }

  private async generateArchitecture(signal: AbortSignal): Promise<string> {
    return this.stage("builderArchAgent", ARCHITECTURE_PROMPT, `Product spec:\n${JSON.stringify(this.spec, null, 2)}`, signal);
  }

  private async generateFile(filePath: string, signal: AbortSignal): Promise<string> {
    const ext = filePath.split(".").pop() ?? "";
    const contextFiles = this.getContextForFile(filePath);

    const messages: ChatMessage[] = [
      { role: "system", content: CODE_GEN_PROMPT },
      {
        role: "user",
        content: [
          `Product: ${this.spec!.name}`,
          `File to generate: ${filePath}`,
          `Tech stack: ${this.spec!.techStack.join(", ")}`,
          `\nArchitecture:\n${this.architecture.slice(0, 2000)}`,
          contextFiles ? `\nAlready generated files for reference:\n${contextFiles}` : "",
          `\nGenerate the complete content for: ${filePath}`,
          ext === "html" ? "\nInclude proper <meta>, <link> and <script> tags." : "",
          ext === "css" ? "\nUse CSS custom properties and modern layout." : "",
          ext === "js" || ext === "ts" ? "\nUse ES modules. Export public API." : "",
        ].filter(Boolean).join("\n"),
      },
    ];

    // The `builder-file` agent checks the file by type (JSON parses,
    // package.json has a name, HTML is a document, nothing empty).
    const { runAgentOrThrow } = await import("../agents/runtime");
    const { builderFileAgent } = await import("../agents/defs");
    return runAgentOrThrow(builderFileAgent, { text: messages[1].content, extra: { path: filePath } }, { signal });
  }

  private async generateTest(filePath: string, sourceCode: string, signal: AbortSignal): Promise<string> {
    return this.stage("builderTestAgent", TEST_GEN_PROMPT, `File: ${filePath}\n\nSource code:\n\`\`\`\n${sourceCode.slice(0, 3000)}\n\`\`\``, signal);
  }

  private async generateDocs(signal: AbortSignal): Promise<string> {
    const fileList = [...this.generatedFiles.keys()].join("\n");
    return this.stage(
      "builderDocsAgent",
      DOCS_PROMPT,
      `Product: ${this.spec!.name}\nDescription: ${this.spec!.description}\nFeatures:\n${this.spec!.features.map((f) => `- ${f}`).join("\n")}\n\nFiles:\n${fileList}`,
      signal,
    );
  }

  private async generateDeployConfig(_signal: AbortSignal): Promise<void> {
    const hasHtml = this.spec!.fileStructure.some((f) => f.endsWith(".html"));

    if (hasHtml) {
      const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${this.spec!.name}</title>
</head>
<body>
  <script>window.location.href = './src/index.html';</script>
</body>
</html>`;
      await this.saveFile(`${this.spec!.name}/index.html`, indexHtml);
    }

    const packageJson = JSON.stringify({
      name: this.spec!.name,
      version: "1.0.0",
      description: this.spec!.description,
      type: "module",
      scripts: {
        dev: "npx serve src",
        test: "node tests/run.js",
      },
    }, null, 2);
    await this.saveFile(`${this.spec!.name}/package.json`, packageJson);

    const dockerFile = [
      "FROM nginx:alpine",
      `COPY src/ /usr/share/nginx/html/`,
      "EXPOSE 80",
    ].join("\n");
    await this.saveFile(`${this.spec!.name}/Dockerfile`, dockerFile);
  }

  private getContextForFile(currentFile: string): string {
    const related: string[] = [];
    for (const [path, content] of this.generatedFiles) {
      if (path.includes(currentFile)) continue;
      if (related.length >= 3) break;
      const shortPath = path.split("/").slice(1).join("/");
      related.push(`--- ${shortPath} ---\n${content.slice(0, 500)}\n`);
    }
    return related.join("\n");
  }

  /** Keep a generated file; nothing reaches the workspace before the whole product is done (`writeAll`). */
  private async saveFile(path: string, content: string): Promise<void> {
    this.generatedFiles.set(path, content);
  }

  /**
   * Write every generated file at once, after the whole product is done:
   * a builder that fails midway leaves 0 files (5.3.2). If a write fails,
   * the files already written are put back as they were (removed, or their
   * earlier text restored), so a product is in the workspace whole or not at
   * all.
   *
   * Written, not staged: proposals need the review screen to be approved
   * (plan 5.11, #223), which this branch does not have yet. Once both are
   * on the same branch, this becomes write_file through the runtime.
   */
  private async writeAll(signal: AbortSignal): Promise<void> {
    if (!isOPFSAvailable()) return;
    const ws = await import("../storage/workspace");
    const done: Array<{ path: string; before: string | null }> = [];
    try {
      for (const [path, content] of this.generatedFiles) {
        if (signal.aborted) throw new DOMException("Cancelled by the user", "AbortError");
        const full = this.projectDir + path;
        const before = (await ws.workspaceHasFile(full)) ? await ws.readWorkspaceFile(full) : null;
        await ws.writeWorkspaceFile(full, content);
        done.push({ path: full, before });
      }
    } catch (e) {
      for (const w of done.reverse()) {
        await (w.before === null ? ws.deleteWorkspaceFile(w.path) : ws.writeWorkspaceFile(w.path, w.before)).catch((err) => log.warn("productAgent", `Could not undo ${w.path}`, err));
      }
      log.warn("productAgent", "Could not write the product's files; none were kept", e);
      throw e;
    }
  }

}

/* ─── Convenience Functions ───────────────────────────────────────── */

/**
 * Quick product creation — one function call, returns all files.
 */
export async function createProduct(
  idea: string,
  onProgress?: AgentProgressCallback,
  signal?: AbortSignal,
): Promise<{ success: boolean; files: Map<string, string>; error?: string }> {
  const agent = new ProductAgent();
  if (onProgress) agent.setProgressCallback(onProgress);
  return agent.run(idea, signal);
}

/**
 * Interactive product creation — streams progress updates.
 */
export function createProductStreaming(idea: string): {
  agent: ProductAgent;
  stream: AsyncGenerator<AgentProgress, void, undefined>;
} {
  const agent = new ProductAgent();
  return { agent, stream: agent.runStreaming(idea) };
}
