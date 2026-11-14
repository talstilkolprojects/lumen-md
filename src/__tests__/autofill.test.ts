/**
 * Plan 5.10 — AI property fill through an approval queue. Acceptance:
 * 0 writes without approval.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => ({ aiKey: null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null }) } }));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));

import { AutofillQueue, autofillSchema, fieldsFrom, proposeFor, runAutofill, type FieldSpec } from "../properties/autofill";
import { validateSchema } from "../agents/schema";
import { registerExecutor, resetExecutors } from "../agents/executors";
import { runAgent } from "../agents/runtime";
import { autofillerAgent } from "../agents/defs";
import { fakeExecutor, sequence } from "./helpers/fakeExecutor";

const vault = [
  { path: "a.md", content: "---\nstatus: draft\ntags: [work]\ndue: 2026-11-01\n---\n# A\n" },
  { path: "b.md", content: "---\nstatus: done\ntags: [home, work]\n---\n# B\n" },
  { path: "c.md", content: "---\nstatus: draft\nrating: 4\nrating2: x\n---\n# C\n" },
  { path: "d.md", content: "# Meeting about the budget\n\nWe finished it yesterday." },
];

describe("fields and schema", () => {
  it("takes the properties used in ≥ 2 notes, with their type and, when few, their values", () => {
    const fields = fieldsFrom(vault);
    expect(fields.map((f) => f.key).sort()).toEqual(["status", "tags"]);
    expect(fields.find((f) => f.key === "status")).toEqual({ key: "status", type: "text", options: ["draft", "done"] });
    expect(fields.find((f) => f.key === "tags")).toMatchObject({ type: "list", options: ["work", "home"] });
  });

  it("the schema allows only the fields, each with its type and values", () => {
    const fields: FieldSpec[] = [{ key: "status", type: "text", options: ["draft", "done"] }, { key: "pages", type: "number" }, { key: "tags", type: "list" }];
    const schema = autofillSchema(fields);
    expect(validateSchema({ values: { status: "done", pages: 3, tags: ["a"] } }, schema)).toEqual([]);
    expect(validateSchema({ values: { status: "archived" } }, schema).length).toBeGreaterThan(0);
    expect(validateSchema({ values: { pages: "three" } }, schema).length).toBeGreaterThan(0);
    expect(validateSchema({ values: { owner: "Tal" } }, schema).length).toBeGreaterThan(0);
  });
});

describe("proposals", () => {
  const fields: FieldSpec[] = [{ key: "status", type: "text", options: ["draft", "done"] }, { key: "tags", type: "list" }, { key: "due", type: "date" }];

  it("fills only missing or empty properties, and keeps the rest of the note byte for byte", () => {
    const text = "---\n# keep this comment\nstatus: draft\ntags:\n---\nBody\r\n";
    const p = proposeFor("n.md", text, { status: "done", tags: ["budget"], due: "yesterday" }, fields)!;
    expect(p.changes).toEqual([{ key: "tags", before: null, after: ["budget"] }]);
    expect(p.next).toContain("# keep this comment");
    expect(p.next).toContain("status: draft");
    expect(p.next.endsWith("Body\r\n")).toBe(true);
    expect(p.base).toBe(text);
    // Nothing to change → no proposal.
    expect(proposeFor("n.md", text, { status: "done" }, fields)).toBeNull();
  });
});

describe("the approval queue (acceptance: 0 writes without approval)", () => {
  let files: Map<string, string>;
  let write: ReturnType<typeof vi.fn>;
  let queue: AutofillQueue;
  const fields: FieldSpec[] = [{ key: "status", type: "text", options: ["draft", "done"] }];
  beforeEach(() => {
    files = new Map([["d.md", vault[3].content], ["e.md", "# E\n"]]);
    write = vi.fn(async (path: string, text: string) => void files.set(path, text));
    queue = new AutofillQueue({ read: async (p) => files.get(p) ?? Promise.reject(new Error("ENOENT")), write: write as (p: string, t: string) => Promise<void> });
  });

  it("running the fill proposes and writes nothing; reject writes nothing; approve writes once", async () => {
    const res = await runAutofill(["d.md", "e.md"], fields, queue, { read: async (p) => files.get(p)!, ask: async () => ({ status: "done" }) });
    expect(res).toEqual({ proposed: 2, unchanged: 0, failed: 0 });
    expect(write).not.toHaveBeenCalled();
    expect(queue.list()).toHaveLength(2);
    queue.reject(queue.list()[1].id);
    expect(write).not.toHaveBeenCalled();
    expect(await queue.approve(queue.list()[0].id)).toBe("written");
    expect(write).toHaveBeenCalledTimes(1);
    expect(files.get("d.md")).toMatch(/^---\nstatus: done\n---\n/);
    expect(files.get("e.md")).toBe("# E\n");
    expect(queue.list()).toHaveLength(0);
  });

  it("a note that changed after the proposal is not written", async () => {
    await runAutofill(["d.md"], fields, queue, { read: async (p) => files.get(p)!, ask: async () => ({ status: "done" }) });
    files.set("d.md", "# Edited meanwhile\n");
    expect(await queue.approve(queue.list()[0].id)).toBe("stale");
    expect(write).not.toHaveBeenCalled();
    expect(files.get("d.md")).toBe("# Edited meanwhile\n");
  });

  it("a failed answer is counted, not written", async () => {
    const res = await runAutofill(["d.md"], fields, queue, { read: async (p) => files.get(p)!, ask: async () => Promise.reject(new Error("model failed")) });
    expect(res.failed).toBe(1);
    expect(queue.list()).toHaveLength(0);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("the autofiller agent", () => {
  beforeEach(() => {
    localStorage.clear();
    resetExecutors();
  });
  const fields: FieldSpec[] = [{ key: "status", type: "text", options: ["draft", "done"] }];

  it("an answer outside the schema is sent back once with the reason", async () => {
    const ex = fakeExecutor(sequence('{"values": {"status": "archived", "owner": "Tal"}}', '{"values": {"status": "done"}}'));
    registerExecutor(ex);
    const run = await runAgent(autofillerAgent, { text: vault[3].content, extra: { fields, schema: autofillSchema(fields) } }, { executor: "ollama" });
    expect(run.status).toBe("ok");
    expect(run.output).toEqual({ values: { status: "done" } });
    expect(ex.calls).toHaveLength(2);
    expect(JSON.stringify(ex.calls[1].messages)).toContain("does not match the properties' schema");
  });
});
