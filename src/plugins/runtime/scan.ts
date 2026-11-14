/**
 * The scan every plugin version gets before it is shown or installed (plan
 * W1.20). It reads the manifest and the code — never runs them — and
 * answers: does the code use only what the manifest declares, and nothing
 * that escapes analysis?
 *
 * Errors (the version fails: hidden in the gallery, refused at install):
 *   - manifest            the manifest does not parse (manifest.ts)
 *   - syntax              the code is not valid JavaScript
 *   - size                the code is larger than the limits below
 *   - eval                eval, Function(…), new Function, string timers
 *   - dynamic-import      import(…), or a static import (plugins are one file)
 *   - obfuscated-access   globalThis / self / lumen indexed with a computed key
 *   - undeclared          an API call whose capability the manifest does not declare
 *   - undeclared-network  a fetch to an origin not declared, or any fetch without a network capability
 *   - signature           a signature that does not verify
 * Warnings (shown on the card, lower the score):
 *   - unused              a declared capability the code never uses
 *   - indirect-api        `lumen` used other than as `lumen.area.method(…)`, so not every call can be checked
 *   - dynamic-network     a fetch whose URL is not a literal
 *   - unsigned / untrusted-signer
 *
 * The sandbox (QuickJS + grants) enforces all of this at run time anyway;
 * the scan makes it visible before install.
 */
import { parse } from "acorn";
import { METHOD_CAPABILITY } from "./capabilities";
import { networkOrigin, parseManifest, type Capability, type CapabilityRequest, type PluginManifest } from "./manifest";

export type ScanRule =
  | "manifest"
  | "syntax"
  | "size"
  | "eval"
  | "dynamic-import"
  | "obfuscated-access"
  | "undeclared"
  | "undeclared-network"
  | "signature"
  | "unused"
  | "indirect-api"
  | "dynamic-network"
  | "unsigned"
  | "untrusted-signer";

export const ERROR_RULES: ReadonlySet<ScanRule> = new Set<ScanRule>(["manifest", "syntax", "size", "eval", "dynamic-import", "obfuscated-access", "undeclared", "undeclared-network", "signature"]);

export interface ScanFinding {
  rule: ScanRule;
  severity: "error" | "warning";
  /** What exactly: the capability, the call, the origin. */
  detail: string;
  /** 1-based line in the code, when the finding is at a place. */
  line?: number;
}

export interface ScanResult {
  id: string;
  version: string;
  /** False when any error was found: the version is not shown and cannot be installed. */
  passed: boolean;
  /** 0–100; 0 when not passed. */
  score: number;
  grade: "A" | "B" | "C" | "F";
  findings: ScanFinding[];
  /** What the manifest declares (empty when it did not parse). */
  capabilities: CapabilityRequest[];
  /** Capabilities the code was seen to use. */
  used: Capability[];
  /** SHA-256 of the code, hex. */
  sha256: string;
}

export interface ScanInput {
  manifest: string | unknown;
  /** The logic entry's source. */
  main: string;
  /** The UI entry's source, when there is one. */
  ui?: string;
  /** Registry signature fields; with `verify`, checked. */
  signature?: { signature?: string; signedBy?: string };
  verify?: (bytes: Uint8Array, entry: { signature?: string; signedBy?: string }) => Promise<true | "untrusted-signer" | false>;
}

export const SCAN_LIMITS = { mainBytes: 512 * 1024, uiBytes: 512 * 1024 } as const;
const WARNING_COST = 10;
/** Events a plugin receives, and the capability that makes them happen. */
const EVENT_CAPABILITY: ReadonlyArray<readonly [string, Capability]> = [
  ["command:", "commands"],
  ["render:", "renderer"],
  ["ui:block", "renderer"],
  ["ui:panel", "panel"],
];

type AstNode = { type: string; start: number; end: number; loc?: { start: { line: number } } } & Record<string, unknown>;

function* walk(node: unknown, parent: AstNode | null = null): Generator<[AstNode, AstNode | null]> {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n, parent);
    return;
  }
  const n = node as AstNode;
  if (typeof n.type !== "string") return;
  yield [n, parent];
  for (const [k, v] of Object.entries(n)) {
    if (k === "loc" || k === "start" || k === "end" || k === "type") continue;
    if (v && typeof v === "object") yield* walk(v, n);
  }
}

const isId = (n: unknown, name?: string): n is AstNode & { name: string } =>
  !!n && (n as AstNode).type === "Identifier" && (name === undefined || (n as { name: string }).name === name);
/** `const NAME = "text"` bindings of the file being analysed (shadowing is not tracked: a re-bound name is dropped). */
let constants = new Map<string, string | null>();
const literalString = (n: unknown): string | null => {
  const x = n as AstNode | undefined;
  if (x?.type === "Identifier") return constants.get((x as unknown as { name: string }).name) ?? null;
  if (x?.type === "Literal" && typeof x.value === "string") return x.value;
  if (x?.type === "TemplateLiteral" && Array.isArray(x.expressions) && x.expressions.length === 0) {
    const q = (x.quasis as Array<{ value: { cooked: string | null } }>)[0];
    return q?.value.cooked ?? null;
  }
  return null;
};
const propName = (m: AstNode): string | null => (m.computed ? literalString(m.property) : isId(m.property) ? m.property.name : null);

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Analyse one source (main or ui) into findings and the capabilities it uses. */
function analyse(code: string, file: string, findings: ScanFinding[], used: Set<Capability>, networkUses: Array<{ origin: string | null; line?: number }>): void {
  let ast: unknown;
  try {
    ast = parse(code, { ecmaVersion: "latest", sourceType: "module", locations: true, allowHashBang: false });
  } catch (e) {
    findings.push({ rule: "syntax", severity: "error", detail: `${file}: ${(e as Error).message}` });
    return;
  }
  const at = (n: AstNode) => n.loc?.start.line;
  // String constants, so `const URL = "https://…"; fetch(URL)` is checked like a literal.
  constants = new Map();
  const declared = new Map<string, number>();
  for (const [n] of walk(ast)) {
    if (n.type === "VariableDeclarator" && isId(n.id)) declared.set((n.id as { name: string }).name, (declared.get((n.id as { name: string }).name) ?? 0) + 1);
  }
  for (const [n] of walk(ast)) {
    if (n.type !== "VariableDeclaration" || n.kind !== "const") continue;
    for (const d of n.declarations as AstNode[]) {
      if (!isId(d.id)) continue;
      const name = (d.id as { name: string }).name;
      const v = d.init && (d.init as AstNode).type !== "Identifier" ? literalString(d.init) : null;
      if (v !== null && declared.get(name) === 1) constants.set(name, v);
    }
  }
  // `lumen.x.y` member expressions that are the callee of a call, so the bare `lumen` they start with is accounted for.
  const apiRoots = new Set<AstNode>();
  for (const [n] of walk(ast)) {
    if (n.type === "ImportExpression" || n.type === "ImportDeclaration" || n.type === "ExportAllDeclaration") {
      findings.push({ rule: "dynamic-import", severity: "error", detail: `${file}: ${n.type === "ImportExpression" ? "import(…)" : "import … from"}`, line: at(n) });
    }
    if (n.type === "CallExpression" || n.type === "NewExpression") {
      const callee = n.callee as AstNode;
      if (isId(callee, "eval") || isId(callee, "Function")) {
        findings.push({ rule: "eval", severity: "error", detail: `${file}: ${n.type === "NewExpression" ? "new " : ""}${(callee as { name: string }).name}(…)`, line: at(n) });
      }
      if ((isId(callee, "setTimeout") || isId(callee, "setInterval")) && literalString((n.arguments as unknown[])[0]) !== null) {
        findings.push({ rule: "eval", severity: "error", detail: `${file}: ${(callee as { name: string }).name} with a string`, line: at(n) });
      }
      // lumen.on("<event>", handler): events arrive for what the plugin registered.
      if (callee.type === "MemberExpression" && isId(callee.object, "lumen") && propName(callee) === "on") {
        apiRoots.add(callee.object as AstNode);
        const event = literalString((n.arguments as unknown[])[0]);
        const cap = event === null ? null : EVENT_CAPABILITY.find(([prefix]) => event.startsWith(prefix))?.[1];
        if (cap) used.add(cap);
      }
      // lumen.<area>.<method>(…)
      if (callee.type === "MemberExpression" && (callee.object as AstNode).type === "MemberExpression" && isId((callee.object as AstNode).object, "lumen")) {
        const area = propName(callee.object as AstNode);
        const method = propName(callee);
        apiRoots.add((callee.object as AstNode).object as AstNode);
        if (area && method) {
          const key = `${area}.${method}`;
          const cap = METHOD_CAPABILITY[key];
          if (cap === "network") {
            const url = literalString((n.arguments as unknown[])[0]);
            let origin: string | null = null;
            if (url !== null) {
              try {
                origin = new URL(url).origin;
              } catch {
                origin = null;
              }
            }
            networkUses.push({ origin: url === null ? null : (origin ?? "invalid"), line: at(n) });
          } else if (cap) used.add(cap);
        }
      }
    }
    // lumen.manifest: the plugin's own manifest, read-only.
    if (n.type === "MemberExpression" && isId(n.object, "lumen") && propName(n) === "manifest") apiRoots.add(n.object as AstNode);
    if (n.type === "MemberExpression" && n.computed && (isId(n.object, "globalThis") || isId(n.object, "self") || isId(n.object, "lumen")) && literalString(n.property) === null) {
      findings.push({ rule: "obfuscated-access", severity: "error", detail: `${file}: ${(n.object as { name: string }).name}[…]`, line: at(n) });
    }
  }
  // Any other use of `lumen` (aliased, destructured, passed around,
  // `lumen.area` on its own) hides calls from the check.
  for (const [n] of walk(ast)) {
    if (isId(n, "lumen") && !apiRoots.has(n)) findings.push({ rule: "indirect-api", severity: "warning", detail: `${file}: lumen used indirectly`, line: at(n) });
  }
}

/** Scan one plugin version. Never throws: a broken input is a failed scan. */
export async function scanPluginVersion(input: ScanInput): Promise<ScanResult> {
  const findings: ScanFinding[] = [];
  let manifest: PluginManifest | null = null;
  try {
    manifest = parseManifest(input.manifest);
  } catch (e) {
    findings.push({ rule: "manifest", severity: "error", detail: (e as Error).message });
  }
  const raw = (input.manifest && typeof input.manifest === "object" ? input.manifest : (() => {
    try {
      return JSON.parse(String(input.manifest)) as unknown;
    } catch {
      return {};
    }
  })()) as { id?: unknown; version?: unknown };
  const id = manifest?.id ?? (typeof raw.id === "string" ? raw.id : "?");
  const version = manifest?.version ?? (typeof raw.version === "string" ? raw.version : "?");

  const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
  if (bytes(input.main) > SCAN_LIMITS.mainBytes) findings.push({ rule: "size", severity: "error", detail: `main: ${bytes(input.main)} bytes (limit ${SCAN_LIMITS.mainBytes})` });
  if (input.ui !== undefined && bytes(input.ui) > SCAN_LIMITS.uiBytes) findings.push({ rule: "size", severity: "error", detail: `ui: ${bytes(input.ui)} bytes (limit ${SCAN_LIMITS.uiBytes})` });

  const used = new Set<Capability>();
  const networkUses: Array<{ origin: string | null; line?: number }> = [];
  analyse(input.main, "main", findings, used, networkUses);
  if (input.ui !== undefined) analyse(input.ui, "ui", findings, used, networkUses);

  const declared = new Set<string>((manifest?.capabilities ?? []).map((c) => c.id));
  if (manifest) {
    for (const cap of used) {
      if (!declared.has(cap)) findings.push({ rule: "undeclared", severity: "error", detail: cap });
    }
    const netDeclared = [...declared].filter((c) => c.startsWith("network:"));
    for (const u of networkUses) {
      if (!netDeclared.length) {
        findings.push({ rule: "undeclared-network", severity: "error", detail: u.origin ?? "network.fetch", line: u.line });
      } else if (u.origin === null) {
        findings.push({ rule: "dynamic-network", severity: "warning", detail: `network.fetch(…) — allowed only to ${netDeclared.map((c) => c.slice(8)).join(", ")}`, line: u.line });
      } else if (!declared.has(`network:${u.origin}`) || networkOrigin(`network:${u.origin}`) === null) {
        findings.push({ rule: "undeclared-network", severity: "error", detail: u.origin, line: u.line });
      } else used.add(`network:${u.origin}`);
    }
    const dynamicNet = networkUses.some((u) => u.origin === null);
    for (const cap of declared) {
      if (used.has(cap as Capability)) continue;
      if (cap.startsWith("network:") && dynamicNet) continue;
      findings.push({ rule: "unused", severity: "warning", detail: cap });
    }
  }

  if (!input.signature?.signature) findings.push({ rule: "unsigned", severity: "warning", detail: "no signature" });
  else if (input.verify) {
    const ok = await input.verify(new TextEncoder().encode(input.main), input.signature).catch(() => false as const);
    if (ok === false) findings.push({ rule: "signature", severity: "error", detail: "the signature does not match the code" });
    else if (ok === "untrusted-signer") findings.push({ rule: "untrusted-signer", severity: "warning", detail: input.signature.signedBy ?? "" });
  }

  for (const f of findings) f.severity = ERROR_RULES.has(f.rule) ? "error" : "warning";
  const passed = !findings.some((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const score = passed ? Math.max(0, 100 - WARNING_COST * warnings) : 0;
  const grade = !passed ? "F" : score >= 90 ? "A" : score >= 70 ? "B" : "C";
  return { id, version, passed, score, grade, findings, capabilities: manifest?.capabilities ?? [], used: [...used].sort(), sha256: await sha256Hex(input.main) };
}

/** Versions the gallery shows: only those whose scan passed. */
export function visibleVersions<T extends { scan: Pick<ScanResult, "passed"> | null }>(versions: readonly T[]): T[] {
  return versions.filter((v) => v.scan?.passed === true);
}
