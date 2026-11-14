/**
 * Agent registry — one definition per palette command. Definitions
 * register themselves from `src/agents/defs/*`; commands look them up by
 * id so the suggestions panel can re-run exactly the agent that failed.
 */

import type { AgentDefinition, AgentInput } from "./types";

const agents = new Map<string, AgentDefinition<AgentInput, unknown>>();

export function registerAgent<I extends AgentInput, O>(def: AgentDefinition<I, O>): AgentDefinition<I, O> {
  agents.set(def.id, def as unknown as AgentDefinition<AgentInput, unknown>);
  return def;
}

export function getAgent(id: string): AgentDefinition<AgentInput, unknown> | undefined {
  return agents.get(id);
}

export function listAgents(): AgentDefinition<AgentInput, unknown>[] {
  return [...agents.values()];
}

/** Tests. */
export function resetAgents(): void {
  agents.clear();
}
