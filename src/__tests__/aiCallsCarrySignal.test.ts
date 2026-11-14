/**
 * 1.4 / T55 — static check: every call to chat(), chatStream(), runAgent() or
 * summarizeMemo() passes a cancel signal, so Esc / "AI: Cancel" can stop it.
 * A call whose options object comes through unchanged from its caller is
 * listed below; anything new without a signal fails this test.
 */
import { describe, it, expect } from "vitest";
import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..");
const CALLEES = new Set(["chat", "chatStream", "runAgent", "runAgentOrThrow", "streamAgent", "summarizeMemo"]);
/** Pass-throughs: the options object already carries the caller's signal. */
const ALLOWED = new Set([
  "agents/executors/chatExecutor.ts:chatStream(messages,opts)", // opts.signal = req.signal
  "agents/executors/chatExecutor.ts:chat(messages,opts)",
  "agents/runtime.ts:runAgent(def,input,opts)", // runAgentOrThrow forwards its opts
  "ai/webllm.worker.ts:chat(id,msg.modelId,msg.request,msg.stream)", // the worker's own function, cancelled via its message protocol
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "__tests__" ? [] : files(p);
    return /\.(ts|tsx)$/.test(f) && !/\.(test|eval)\./.test(f) ? [p] : [];
  });
}

function callsWithoutSignal(): string[] {
  const out: string[] = [];
  for (const file of files(ROOT)) {
    const src = readFileSync(file, "utf8");
    if (![...CALLEES].some((c) => src.includes(`${c}(`))) continue;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const e = n.expression;
        const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
        if (name && CALLEES.has(name)) {
          const args = n.arguments.map((a) => a.getText(sf).replace(/\s+/g, "")).join(",");
          const key = `${relative(ROOT, file)}:${name}(${args})`;
          if (!/signal/.test(args) && !ALLOWED.has(key)) {
            const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
            out.push(`${relative(ROOT, file)}:${line} ${name}(${args.slice(0, 80)})`);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

describe("AI calls carry a cancel signal (T55)", () => {
  it("no chat / chatStream / runAgent / summarizeMemo call is missing a signal", () => {
    expect(callsWithoutSignal()).toEqual([]);
  });
});
