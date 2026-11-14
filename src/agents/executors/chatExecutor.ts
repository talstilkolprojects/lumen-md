/**
 * The "chat" executor — the runtime on top of today's `chat()` /
 * `chatStream()`. It speaks to whatever provider the user selected
 * (Ollama, in-browser WebGPU, or a cloud provider when the policy allows)
 * and has no native tool calling or constrained output, so the runtime
 * drives it with the JSON-ReAct protocol. The native Ollama and web-llm
 * executors come first when they are available; this one is the floor
 * every agent can stand on.
 */

import type { Availability, Executor, ExecutorMessage, ExecutorRequest, ExecutorResponse, ModelTier } from "../types";
import { chat, chatStream, effectiveModel, getActiveProvider, LIGHT_MODELS, type ChatMessage } from "../../ai/llm";
import { estimateTokens } from "../../ai/usage";
import { getAiPolicy, isCloudProvider, isLocalOrigin } from "../../ai/policy";
import { useAppStore } from "../../store/useStore";
import { toolResultMessage } from "../protocol";

/** Flatten tool turns into plain chat messages for a text-only provider. */
export function flattenMessages(messages: ExecutorMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant" && m.toolCalls?.length && !m.content) {
      out.push({ role: "assistant", content: JSON.stringify({ tool: m.toolCalls[0].name, args: m.toolCalls[0].args }) });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  // Providers reject consecutive user turns; merge them.
  const merged: ChatMessage[] = [];
  for (const m of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === "user" && m.role === "user") prev.content += "\n\n" + m.content;
    else merged.push({ ...m });
  }
  return merged;
}

export const chatExecutor: Executor = {
  id: "chat",
  label: "Lumen chat()",
  async available(): Promise<Availability> {
    const provider = getActiveProvider();
    const policy = getAiPolicy();
    const { isOllamaAvailable, getBaseUrl } = await import("../../ai/ollamaProvider");
    const { localLlmAvailable } = await import("../../ai/localLlm");
    const ollamaUp = async () => isLocalOrigin(getBaseUrl()) && (await isOllamaAvailable());
    if (provider === "ollama") {
      if (policy === "local-only" && !isLocalOrigin(getBaseUrl())) return { available: false, reason: "policy", detail: getBaseUrl() };
      return (await isOllamaAvailable()) ? { available: true } : { available: false, reason: "ollama-offline", detail: getBaseUrl() };
    }
    if (provider === "local-webgpu") {
      return localLlmAvailable().available ? { available: true } : { available: false, reason: "no-webgpu" };
    }
    if (isCloudProvider(provider)) {
      // Mirrors chat()'s localRoute(): under a local policy a reachable
      // Ollama (or WebGPU when opted in / local-only) answers instead.
      if (policy !== "cloud") {
        if (await ollamaUp()) return { available: true };
        if ((policy === "local-only" || useAppStore.getState().useLocalAi) && localLlmAvailable().available) return { available: true };
        if (policy === "local-only") return { available: false, reason: "no-local", detail: provider };
      }
      const { hasAiCredentials } = await import("../../ai/credentials");
      return hasAiCredentials() ? { available: true } : { available: false, reason: "no-key", detail: provider };
    }
    return { available: true };
  },
  supportsTools: () => false,
  supportsSchema: () => false,
  /**
   * The model chat() is expected to use, for traces and cache keys: the
   * provider's light model for tiny/small agents (the router's choice in
   * the default mode), else its configured model. Under a local policy
   * chat() may answer from Ollama / WebGPU instead; the response reports
   * the model that actually answered.
   */
  modelFor(tier: ModelTier): string {
    const provider = getActiveProvider();
    const light = tier === "tiny" || tier === "small" ? LIGHT_MODELS[provider] : undefined;
    return light ?? effectiveModel(provider);
  },
  async chat(req: ExecutorRequest): Promise<ExecutorResponse> {
    const messages = flattenMessages(req.messages);
    let answeredBy: string | null = null;
    const opts = {
      // Only an explicit choice (a retry with another model) is pinned: the
      // model the runtime resolved from modelFor() is left to chat()'s own
      // routing, so light tiers keep the light model and a request rerouted
      // to a local backend never carries a cloud model name.
      model: req.model && req.model !== chatExecutor.modelFor(req.tier ?? "small") ? req.model : undefined,
      maxTokens: req.maxTokens,
      temperature: req.temperature,
      signal: req.signal,
      tier: req.tier === "tiny" || req.tier === "small" ? ("light" as const) : undefined,
      // The runtime's once-per-run charge, made by chat() at dispatch.
      prepaid: !req.charge,
      chargeHook: req.charge,
      onRoute: (_p: string, m: string) => {
        answeredBy = m;
      },
      onUsage: (u: { model?: string }) => {
        if (u.model) answeredBy = u.model;
      },
    };
    let content = "";
    if (req.onDelta) {
      for await (const chunk of chatStream(messages, opts)) {
        content += chunk;
        req.onDelta(chunk);
      }
    } else {
      content = await chat(messages, opts);
    }
    return {
      content,
      toolCalls: [],
      model: answeredBy ?? req.model ?? chatExecutor.modelFor(req.tier ?? "small"),
      usage: {
        inputTokens: estimateTokens(messages.map((m) => m.content).join("\n")),
        outputTokens: estimateTokens(content),
        estimated: true,
      },
    };
  },
};

export { toolResultMessage };
