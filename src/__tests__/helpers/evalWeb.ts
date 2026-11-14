/**
 * The web of the agent eval (plan 5.4): a fetch that answers the eval's
 * research service with EVAL_WEB (one search result, one page) and passes
 * everything else to the real fetch (Ollama, in the live eval).
 *
 *   installEvalWeb(); // once per test file / eval run
 */
import { EVAL_WEB } from "../../agents/eval/fixtures";

export const EVAL_RESEARCH_ENDPOINT = "https://research.eval.example";

export function installEvalWeb(): () => void {
  const real = globalThis.fetch;
  const stub: typeof fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith(EVAL_RESEARCH_ENDPOINT)) return real(input, init);
    if (url.startsWith(`${EVAL_RESEARCH_ENDPOINT}/search`)) return Response.json({ results: EVAL_WEB.search });
    const asked = decodeURIComponent(url.split("url=")[1] ?? "");
    if (asked === EVAL_WEB.page.url) return Response.json({ finalUrl: EVAL_WEB.page.url, status: 200, title: EVAL_WEB.page.title, text: EVAL_WEB.page.text });
    return Response.json({ finalUrl: asked, status: 404, error: "not in the eval web" });
  };
  globalThis.fetch = stub;
  try {
    localStorage.setItem("lumen.research.endpoint", EVAL_RESEARCH_ENDPOINT);
    localStorage.setItem("lumen.research.provider", "searxng");
  } catch {
    /* why: storage denied */
  }
  return () => {
    globalThis.fetch = real;
  };
}
