import type { Executor, ExecutorRequest, ExecutorResponse } from "../../agents/types";

export type Script = (req: ExecutorRequest, n: number) => ExecutorResponse | Promise<ExecutorResponse>;

/** A scripted executor: the n-th call gets the n-th response. Registers as "ollama" unless overridden. */
export function fakeExecutor(script: Script, opts: Partial<Executor> = {}): Executor & { calls: ExecutorRequest[] } {
  const calls: ExecutorRequest[] = [];
  return {
    id: "ollama",
    label: "fake",
    calls,
    available: async () => ({ available: true }),
    supportsTools: () => false,
    supportsSchema: () => false,
    modelFor: (tier) => `fake-${tier}`,
    async chat(req) {
      calls.push(req);
      return script(req, calls.length);
    },
    ...opts,
  };
}

export const reply = (content: string, model = "fake-small"): ExecutorResponse => ({ content, toolCalls: [], model, usage: { inputTokens: 10, outputTokens: 5, estimated: true } });

/** A script that returns each text in turn, then repeats the last. */
export function sequence(...texts: string[]): Script {
  return (req, n) => reply(texts[Math.min(n, texts.length) - 1], req.model ?? "fake-small");
}
