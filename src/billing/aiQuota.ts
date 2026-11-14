/**
 * Monthly AI prompt quota (Capabilities.aiMonthlyPrompts).
 *
 * A small client-side counter keyed by calendar month
 * (`lumen.ai.quota.YYYY-MM`). It is a UX guard, not a security boundary —
 * the hosted AI proxy enforces the real limit server-side. Storage access
 * is wrapped in try/catch: with storage denied the counter reads 0 and the
 * user is never blocked by a storage failure.
 *
 * Counting happens where AI commands are *dispatched* (command palette,
 * editor AI actions) rather than inside `ai/llm.ts`, so one user action
 * counts as one prompt even when an agent fans out into several requests.
 */

import { effectiveCapabilities, gatesEnforced } from "./gates";
import { showAiToast } from "../ui/AiToast";
import { t } from "../i18n";
import { hasAiCredentials } from "../ai/credentials";
import { UserFacingError } from "../lib/userError";

const KEY_PREFIX = "lumen.ai.quota.";

export function monthKey(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return `${KEY_PREFIX}${now.getFullYear()}-${m}`;
}

/** Prompts used in the month containing `now`. */
export function getAiUsage(now: Date = new Date()): number {
  try {
    const raw = localStorage.getItem(monthKey(now));
    const n = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Increment this month's counter; drops counters from earlier months. */
export function recordAiPrompt(now: Date = new Date()): number {
  const key = monthKey(now);
  const next = getAiUsage(now) + 1;
  try {
    localStorage.setItem(key, String(next));
    // Housekeeping: old months are dead weight.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(KEY_PREFIX) && k !== key) localStorage.removeItem(k);
    }
  } catch {
    /* why: storage denied — the counter just doesn't persist */
  }
  return next;
}

export interface AiQuotaStatus {
  allowed: boolean;
  used: number;
  /** `Infinity` when unlimited (no billing configured). */
  limit: number;
  remaining: number;
}

export function aiQuotaStatus(now: Date = new Date()): AiQuotaStatus {
  const limit = gatesEnforced() ? effectiveCapabilities().aiMonthlyPrompts : Number.POSITIVE_INFINITY;
  const used = getAiUsage(now);
  const remaining = Math.max(0, limit - used);
  return { allowed: remaining > 0, used, limit, remaining };
}

/**
 * Gate one AI prompt: returns true (and counts it) when allowed; otherwise
 * shows an upgrade toast and returns false. Unlimited (self-hosted / no
 * billing) setups always pass and nothing is written to storage.
 *
 * Every production path that calls the LLM goes through this (palette
 * commands via `withAiQuota`, Ask Workspace, Ctrl-Space completion,
 * automatic inline suggestions, WYSIWYG Ghostwriter/Rewrite, CSV chart).
 * Background callers pass `{ silent: true }` so an exhausted quota just
 * stops them instead of toasting on every keystroke.
 */
export function consumeAiPrompt(now: Date = new Date(), opts: { silent?: boolean } = {}): boolean {
  if (!gatesEnforced()) return true;
  const status = aiQuotaStatus(now);
  if (!Number.isFinite(status.limit)) return true;
  // No usable provider: the request fails before reaching any model (the
  // caller surfaces "configure your key"), so it must not spend a prompt.
  // Background callers (inline suggestions) simply don't start.
  if (!hasAiCredentials()) return !opts.silent;
  if (!status.allowed) {
    if (!opts.silent) showAiToast(t("billing.aiQuota.exceeded", { limit: status.limit }), "error");
    return false;
  }
  recordAiPrompt(now);
  return true;
}

/**
 * Palette command ids that send a prompt to the LLM. Settings / provider
 * pickers / local-model toggles are deliberately absent — they don't spend
 * a prompt.
 */
const AI_PROMPT_COMMANDS = new Set([
  "ai.outline",
  "ai.productAgent",
  "ai.diagram",
  "ai.actionItems",
  "ai.translate",
  "ai.chart",
  "tools.autoTag",
  "tools.suggestLinks",
  "research.ask",
  // voice.memo is NOT listed: recording and transcription are local; the
  // summary pays for itself (ownPrompt) and the memo tolerates its absence.
]);

export function isAiPromptCommand(id: string): boolean {
  return AI_PROMPT_COMMANDS.has(id) || id.startsWith("ai.prompt.");
}

/**
 * Palette commands currently running (passed the up-front quota check).
 * A command is charged when it actually dispatches (see
 * `chargeAiCommandDispatch`, called by chat()/chatStream()), not when it
 * starts — cancelling its prompt dialog or failing a prerequisite (no
 * workspace file, too-short document…) must not spend a prompt. A command
 * that makes several model calls is charged once: its token stays in the
 * list (marked charged) until the command settles.
 */
const armedCommands: { charged: boolean }[] = [];

/** Thrown by the LLM layer when an uncounted request would exceed the quota. */
export class AiQuotaExceededError extends UserFacingError {
  constructor(limit: number) {
    super(t("billing.aiQuota.exceeded", { limit }));
    this.name = "AiQuotaExceededError";
  }
}

/**
 * Called by the LLM layer right before a request is sent (requests whose
 * caller already counted them pass `prepaid` to chat() and never get here).
 *  - A running palette command that hasn't dispatched yet pays for it
 *    (palette commands are modal, one at a time); its follow-up calls are
 *    free.
 *  - Known non-palette callers (inline suggestions, Ask Workspace,
 *    voice-memo summary, AI commit message, …) count themselves with
 *    consumeAiPrompt and dispatch as `prepaid`, so they never take a
 *    waiting command's reservation.
 *  - Anything else with no running command is enforced and counted here
 *    (safety net), so no path bypasses the monthly limit. Throws
 *    AiQuotaExceededError when the quota is spent.
 */
export function chargeAiCommandDispatch(now: Date = new Date()): void {
  if (armedCommands.length) {
    const pending = armedCommands.find((c) => !c.charged);
    if (!pending) return; // follow-up call of a command that already paid
    if (gatesEnforced()) {
      const status = aiQuotaStatus(now);
      if (Number.isFinite(status.limit) && hasAiCredentials()) {
        // Re-check at dispatch: another request may have used the last
        // prompt while this command waited in its dialog.
        if (!status.allowed) {
          showAiToast(t("billing.aiQuota.exceeded", { limit: status.limit }), "error");
          throw new AiQuotaExceededError(status.limit);
        }
        recordAiPrompt(now);
      }
    }
    pending.charged = true;
    return;
  }
  if (!gatesEnforced()) return;
  const status = aiQuotaStatus(now);
  if (!Number.isFinite(status.limit) || !hasAiCredentials()) return;
  if (!status.allowed) {
    showAiToast(t("billing.aiQuota.exceeded", { limit: status.limit }), "error");
    throw new AiQuotaExceededError(status.limit);
  }
  recordAiPrompt(now);
}

/** Charge one prompt now (enforced, with the usual exceeded toast). */
function chargeUpFront(now: Date = new Date()): void {
  if (!gatesEnforced()) return;
  const status = aiQuotaStatus(now);
  if (!Number.isFinite(status.limit) || !hasAiCredentials()) return;
  if (!status.allowed) {
    showAiToast(t("billing.aiQuota.exceeded", { limit: status.limit }), "error");
    throw new AiQuotaExceededError(status.limit);
  }
  recordAiPrompt(now);
}

/** Wrap the actions of AI-prompt commands with the quota check. */
export function withAiQuota<C extends { id: string; action: () => void; children?: C[] }>(
  commands: C[],
): C[] {
  return commands.map((c) => {
    const children = c.children ? withAiQuota(c.children) : c.children;
    if (!isAiPromptCommand(c.id)) return children === c.children ? c : { ...c, children };
    const action = c.action;
    return {
      ...c,
      children,
      action: () => {
        // Block up front when the quota is spent (so the user isn't walked
        // through a dialog that can't run), but only charge on dispatch.
        if (gatesEnforced()) {
          const status = aiQuotaStatus();
          if (Number.isFinite(status.limit) && !status.allowed) {
            showAiToast(t("billing.aiQuota.exceeded", { limit: status.limit }), "error");
            return;
          }
        }
        const token = { charged: false };
        // Dispatches can't be traced back to the command that made them
        // (actions aren't awaited and may pause on lazy imports), so with
        // two commands in flight a dispatch could pay with the other one's
        // token. Only one command may wait to be charged at a time: a
        // command started while another is still in flight pays up front.
        if (armedCommands.length > 0) {
          try {
            chargeUpFront();
          } catch {
            return; // quota spent — toast already shown
          }
          token.charged = true;
        }
        armedCommands.push(token);
        // Never dispatched (cancelled / prerequisite failed)? Release it uncharged.
        const disarm = () => {
          const i = armedCommands.indexOf(token);
          if (i >= 0) armedCommands.splice(i, 1);
        };
        try {
          const result = action() as unknown;
          if (result && typeof (result as Promise<unknown>).finally === "function") {
            return (result as Promise<unknown>).finally(disarm) as unknown as void;
          }
          disarm();
          return result as void;
        } catch (err) {
          disarm();
          throw err;
        }
      },
    };
  });
}
