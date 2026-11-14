/**
 * Plan W4.31 — the probe set's tool specs are copies of the real tools'
 * schemas (so the mock measurement loads without the tools' dependencies):
 * they must not drift from src/agents/tools/.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => ({}) } }));

import { ALL_TOOLS } from "../agents/tools";
import { PROBE_TOOLS } from "../agents/eval/toolProbes";

describe("probe tool specs", () => {
  it.each(PROBE_TOOLS.map((t) => [t.name, t] as const))("%s matches the real tool's schema", (name, spec) => {
    const real = ALL_TOOLS.find((t) => t.name === name);
    expect(real, name).toBeDefined();
    expect(spec.parameters).toEqual(real!.parameters);
  });
});
