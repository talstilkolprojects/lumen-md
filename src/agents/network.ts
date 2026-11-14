/**
 * The network gate for agent tools (scope `network`).
 *
 * Under the `local-only` AI policy nothing may leave the device — with one
 * explicit exception (plan §2.4): web research, which by its nature asks
 * the web. A network tool call therefore goes out only when the user
 * consented to that call (asked per call — plan 15.10 (8)); otherwise it is
 * refused before any request is made,
 * the refusal is recorded in the privacy ledger and the call fails with
 * the ledger's `PrivacyBlockedError`. Under `local-first` / `cloud` the
 * policy itself allows the network.
 *
 * Either way the tool gets a fetch built by the ledger (`ledgerFetch`), so
 * each request it makes is recorded (host, bytes, reason, policy, and
 * whether it went out on consent). A network tool has no other way to the
 * network: without the gate's fetch it refuses to run (`networkFetch`).
 */

import type { AgentTool, NetworkConsentRequest, ToolCall } from "./types";
import { getAiPolicy } from "../ai/policy";
import { ledgerFetch, recordBlockedRequest } from "../ai/privacyLedger";
import { ToolError } from "./tools/define";

export type ConsentHook = (request: NetworkConsentRequest) => boolean | Promise<boolean>;

/** The research service and settings a network call was described (and approved) with; the tool uses exactly these. */
export interface NetworkBinding {
  endpoint: string;
  settings: import("../research/client").ResearchSettings;
}

/**
 * What the call would send and where, for the consent prompt and the
 * ledger. Every network tool goes through the research service (SearXNG /
 * the research worker); without one configured nothing could be sent, so
 * the call fails here, before any consent is asked.
 */
export async function describeNetworkCall(tool: AgentTool, call: ToolCall): Promise<NetworkConsentRequest & { url: string; bound: NetworkBinding }> {
  const { researchEndpoint, getResearchSettings } = await import("../research/client");
  const endpoint = researchEndpoint();
  if (!endpoint) throw new ToolError("failed", "The research service isn't configured (VITE_RESEARCH_ENDPOINT or a local SearXNG in AI settings), so there is no way to reach the web");
  const hostOf = (u: string) => {
    try {
      return new URL(u).hostname;
    } catch {
      return "";
    }
  };
  const service = hostOf(endpoint);
  // What the prompt describes is what the call will use: settings changed
  // while the dialog is open (another tab, a hook) do not reach this call.
  const bound: NetworkBinding = { endpoint, settings: getResearchSettings() };
  if (tool.name === "fetch_page") {
    // The address goes to the research service (in its query string), which then visits the page.
    const page = typeof call.args.url === "string" ? call.args.url : "";
    return { tool: tool.name, host: service, sends: "the page address", what: "page-address", visits: hostOf(page) || undefined, args: call.args, url: `${endpoint}/extract`, bound };
  }
  if (tool.name === "search_web") {
    // Brave and Tavily need the user's API key, which the service forwards: say so.
    const s = bound.settings;
    const credential = s.key && (s.provider === "brave" || s.provider === "tavily") ? (s.provider === "brave" ? "Brave Search" : "Tavily") : undefined;
    return { tool: tool.name, host: service, sends: credential ? `the search query and your ${credential} API key` : "the search query", what: "search-query", credential, args: call.args, url: `${endpoint}/search`, bound };
  }
  return { tool: tool.name, host: service, sends: "the tool's arguments", what: "tool-args", args: call.args, url: `${endpoint}/search`, bound };
}

/**
 * The owner's decision (plan 15.10 (8), 18.10): under local-only every agent
 * network call is asked for on its own — the one-time research consent does
 * not count. The prompt names the tool, the host and exactly what is sent.
 */
/**
 * What the call sends, verbatim and whole: the agent wrote it, possibly
 * from the open note, so the prompt shows all of it (a query is at most 400
 * characters, a page address 2 000) rather than a part, or a promise that
 * no note text leaves the device.
 */
export function sentValue(req: Pick<NetworkConsentRequest, "what" | "args">): string {
  const v = req.what === "search-query" ? req.args.query : req.what === "page-address" ? req.args.url : undefined;
  return typeof v === "string" ? v : JSON.stringify(req.args);
}

async function defaultConsent(req: NetworkConsentRequest): Promise<boolean> {
  return askNetworkConsent(req, { perCall: true });
}

/**
 * The network consent prompt: tool, host, the whole value that is sent,
 * the credential and the visited host, and (plan 2.7) the warning when the
 * run has read outside content. `perCall`: say that local-only asks for
 * every call (the prompt is also the untrusted-content approval under the
 * other policies, where that line would be wrong).
 */
export async function askNetworkConsent(req: NetworkConsentRequest, opts: { perCall: boolean }): Promise<boolean> {
  const [{ uiConfirm }, { t }] = await Promise.all([import("../ui/PromptDialog"), import("../i18n")]);
  const what = t(`agents.netConsent.what.${req.what}`);
  const parts = [
    t("agents.netConsent.body", { tool: req.tool, host: req.host, sends: what }),
    t("agents.netConsent.exact", { value: sentValue(req) }),
    req.credential ? t("agents.netConsent.credential", { provider: req.credential }) : "",
    req.visits ? t("agents.netConsent.visits", { host: req.visits }) : "",
    req.untrusted?.length ? t("agents.netConsent.untrusted", { sources: (await import("./untrusted")).sourcesLabel(req.untrusted) }) : "",
    opts.perCall ? t("agents.netConsent.perCall") : "",
  ];
  return uiConfirm({ title: t("agents.netConsent.title"), message: parts.filter(Boolean).join(" "), okLabel: t("agents.netConsent.ok") });
}

/**
 * Decide one network tool call. Resolves to the fetch the tool must use;
 * rejects with `PrivacyBlockedError` (recorded as blocked) when the
 * `local-only` policy holds and the user did not consent to this call.
 */
export async function openNetworkGate(
  tool: AgentTool,
  call: ToolCall,
  consent?: ConsentHook,
  guard?: { untrusted: string[]; approve: (req: NetworkConsentRequest) => Promise<boolean> },
): Promise<{ fetch: typeof fetch; consented: boolean; bound: NetworkBinding }> {
  const reason = `Agent tool ${tool.name}`;
  const { url, bound, ...described } = await describeNetworkCall(tool, call);
  const req = guard?.untrusted.length ? { ...described, untrusted: guard.untrusted } : described;
  if (getAiPolicy() !== "local-only") {
    // Plan 2.7: with untrusted content in the run, the call needs the user's
    // approval even where the policy allows the network (the page that was
    // read may be what asks for this request).
    if (guard?.untrusted.length) {
      let ok = false;
      try {
        ok = await guard.approve(req);
      } catch {
        ok = false;
      }
      if (!ok) {
        recordBlockedRequest(url, "research", `${reason} (untrusted content in the run, not approved)`);
        throw new ToolError("denied", (await import("./untrusted")).UNTRUSTED_DENIED);
      }
      return { fetch: boundFetch(ledgerFetch({ force: { category: "research", reason: `${reason} (approved: untrusted content in the run)` }, consent: true }), bound.endpoint), consented: true, bound };
    }
    return { fetch: boundFetch(ledgerFetch({ force: { category: "research", reason } }), bound.endpoint), consented: false, bound };
  }
  let ok = false;
  try {
    ok = await (consent ?? defaultConsent)(req);
  } catch {
    ok = false;
  }
  if (!ok) throw recordBlockedRequest(url, "research", `${reason} (local-only, no consent)`);
  return { fetch: boundFetch(ledgerFetch({ force: { category: "research", reason: `${reason} (user consent)` }, consent: true }), bound.endpoint), consented: true, bound };
}

/** A fetch that reaches only the research service the call was approved for. */
function boundFetch(inner: typeof fetch, endpoint: string): typeof fetch {
  return (input, init) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (target !== endpoint && !target.startsWith(`${endpoint}/`) && !target.startsWith(`${endpoint}?`)) {
      return Promise.reject(new ToolError("denied", `This call was approved for ${endpoint} only`));
    }
    return inner(input, init);
  };
}
