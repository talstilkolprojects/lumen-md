/**
 * The PII redactor on the cloud path (plan 2.6): llm.ts calls
 * `redactForCloud` right before a cloud provider is contacted (never for
 * Ollama on this machine or the in-browser model) and restores the
 * tokens in the answer.
 *
 *   setting   `lumen.ai.redact`: "on" (default) | "off". Off is a choice the
 *             user makes in AI settings; local-only never reaches here.
 *   preview   `lumen.ai.redact.preview` = "1": before each cloud request the
 *             user sees the redacted text and may cancel (2.6.4).
 *   names     with the DictaBERT-NER model downloaded (consent, plan 6.0)
 *             Hebrew names are found too; without it, patterns only.
 *   ledger    each request's counts per type go to `piiLog` (no values).
 *
 * Loaded on demand from llm.ts: nothing here is on the startup path.
 */

import { PiiVault, redactText, type NerFn, type PiiType } from "./pii";

const SETTING = "lumen.ai.redact";
const PREVIEW = "lumen.ai.redact.preview";

export function redactionEnabled(): boolean {
  try {
    return localStorage.getItem(SETTING) !== "off";
  } catch {
    return true;
  }
}

export function setRedactionEnabled(on: boolean): void {
  localStorage.setItem(SETTING, on ? "on" : "off");
}

export function previewEnabled(): boolean {
  try {
    return localStorage.getItem(PREVIEW) === "1";
  } catch {
    return false;
  }
}

export function setPreviewEnabled(on: boolean): void {
  localStorage.setItem(PREVIEW, on ? "1" : "0");
}

/* ── The redaction log (counts only) ─────────────────────────────────── */

export interface RedactionRecord {
  ts: number;
  provider: string;
  counts: Partial<Record<PiiType, number>>;
  names: boolean;
}

let log: RedactionRecord[] = [];
const listeners = new Set<() => void>();

export function redactionLog(): readonly RedactionRecord[] {
  return log;
}

export function subscribeRedactionLog(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Total redactions per type over the log (for the privacy ledger header). */
export function redactionTotals(list: readonly RedactionRecord[] = log): { requests: number; items: number } {
  return { requests: list.length, items: list.reduce((n, r) => n + Object.values(r.counts).reduce((a, b) => a + (b ?? 0), 0), 0) };
}

function record(r: RedactionRecord): void {
  log = [...log, r].slice(-200);
  for (const fn of [...listeners]) fn();
}

/* ── Names (NER) ─────────────────────────────────────────────────────── */

let nerOverride: NerFn | null | undefined;

/** Tests and the eval inject a name finder; null forces patterns only. */
export function __setNer(fn: NerFn | null | undefined): void {
  nerOverride = fn;
}

/**
 * The Hebrew name finder when DictaBERT-NER is already on this device.
 * Never downloads here: a cloud request must not start a 100 MB download;
 * the model is fetched with consent from Settings → Models (plan 6.0).
 */
async function namesFinder(): Promise<NerFn | null> {
  if (nerOverride !== undefined) return nerOverride;
  try {
    const { nerIfCached } = await import("./piiNer");
    return await nerIfCached();
  } catch {
    return null;
  }
}

/* ── The request path ─────────────────────────────────────────────────── */

export interface Message {
  role: string;
  content: string;
}

/** Thrown when the user cancels the preview: the request was not sent. */
export class RedactionCancelledError extends Error {
  constructor() {
    super("Cancelled before sending to the cloud");
    this.name = "AbortError";
  }
}

export type PreviewFn = (redacted: Message[], counts: Partial<Record<PiiType, number>>) => Promise<boolean>;

let previewOverride: PreviewFn | null = null;
export function __setPreview(fn: PreviewFn | null): void {
  previewOverride = fn;
}

async function showPreview(redacted: Message[], counts: Partial<Record<PiiType, number>>): Promise<boolean> {
  if (previewOverride) return previewOverride(redacted, counts);
  const { uiConfirm } = await import("../ui/PromptDialog");
  const { t } = await import("../i18n");
  const summary = Object.entries(counts)
    .map(([k, n]) => `${t(`pii.type.${k}`)}: ${n}`)
    .join(" · ");
  const body = redacted
    .filter((m) => m.role !== "system")
    .map((m) => m.content)
    .join("\n\n")
    .slice(0, 4000);
  return uiConfirm({
    title: t("pii.preview.title"),
    message: `${summary ? `${t("pii.preview.hidden", { list: summary })}\n\n` : `${t("pii.preview.none")}\n\n`}${body}`,
    okLabel: t("pii.preview.send"),
  });
}

export interface Redacted<M extends Message> {
  messages: M[];
  vault: PiiVault;
}

/**
 * Redact every message for a request to `provider`. With redaction off the
 * messages pass unchanged (an empty vault restores nothing). Throws
 * RedactionCancelledError when the user cancels the preview.
 */
export async function redactForCloud<M extends Message>(messages: M[], provider: string): Promise<Redacted<M>> {
  const vault = new PiiVault();
  if (!redactionEnabled()) return { messages, vault };
  const ner = await namesFinder();
  const out: M[] = [];
  for (const m of messages) out.push({ ...m, content: typeof m.content === "string" ? await redactText(m.content, vault, { ner }) : m.content });
  if (vault.size) record({ ts: Date.now(), provider, counts: { ...vault.counts }, names: !!ner });
  if (previewEnabled() && !(await showPreview(out, vault.counts))) throw new RedactionCancelledError();
  return { messages: out, vault };
}
