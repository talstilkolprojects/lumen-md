#!/usr/bin/env node
// A fake Ollama server for tests: answers /api/tags, /api/version, /api/show,
// /api/chat, /api/embed, /api/pull (streamed progress) and /api/delete over real HTTP, so the app's local-AI path can be
// exercised in CI without a GPU or a model download.
//
//   npm run fake-ollama -- [--port 11434] [--fixtures src/agents/eval/fixtures.ts]
//
// Chat answers come from the eval fixtures: the first case whose input text
// appears in the prompt wins; anything else gets a generic JSON/text answer.
// When the agent may call tools (native `tools`, or JSON-ReAct under the
// protocol's `format`), the first answer is the case's expected tool call
// (plan 5.3) and the reference answer comes once its result is back.
// Embeddings are deterministic hashes, so equal texts give equal vectors.
import http from "node:http";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";

const args = process.argv.slice(2);
const opt = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};
const port = Number(opt("--port", process.env.FAKE_OLLAMA_PORT || 11434));
const fixturesPath = opt("--fixtures", "src/agents/eval/fixtures.ts");

// The fixtures are TypeScript; Node ≥ 22.6 strips the types on import
// (`--experimental-strip-types`, which the npm script passes). They import
// each other the bundler way (`./moreCases`, no extension), which Node does
// not resolve: retry a relative specifier with `.ts`.
if (typeof registerHooks === "function") {
  registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context);
      } catch (e) {
        if (e?.code !== "ERR_MODULE_NOT_FOUND" || !/^\.\.?\//.test(specifier) || /\.[cm]?[jt]s$/.test(specifier)) throw e;
        return next(`${specifier}.ts`, context);
      }
    },
  });
}
let cases = [];
try {
  const mod = await import(new URL(fixturesPath, `file://${process.cwd()}/`).href);
  // The key is the start of the input's first line: an agent may reshape the
  // text around it (the outliner numbers the lines), not within a line.
  cases = (mod.EVAL_CASES ?? []).map((c) => ({ id: c.id, agent: c.agent, key: String(c.input.text ?? "").trim().split("\n")[0].slice(0, 40), full: String(c.input.text ?? "").trim(), example: c.example, tool: c.tool }));
} catch (e) {
  // hygiene-allow: a CLI fixture reporting its own startup problem
  console.error(`fake ollama: fixtures not loaded (${e?.message ?? e}); generic answers only`);
}

const MODELS = [
  { name: "qwen2.5:7b", details: { parameter_size: "7.6B", family: "qwen2" } },
  { name: "llama3.2:3b", details: { parameter_size: "3.2B", family: "llama" } },
  { name: "nomic-embed-text:latest", details: { parameter_size: "137M", family: "nomic-bert" } },
];

// Which agent is asking: the system prompt names its job.
const AGENT_HINTS = {
  translator: /translat/i,
  tasker: /action items?/i,
  outliner: /heading/i,
  tagger: /\btags?\b/i,
  linker: /link/i,
  proofreader: /proofread/i,
  diagrammer: /mermaid/i,
  charter: /echarts/i,
  committer: /commit/i,
  writer: /ghostwriter|continue/i,
  templater: /follow the instruction/i,
  stylist: /writer's style/i,
  builder: /product architect/i,
  formulator: /database column|formula/i,
};

/** The case's own tool call is already in the conversation (a context call has other arguments). */
function madeCall(messages, tool) {
  const want = JSON.stringify(tool.args ?? {});
  return messages.some((m) => (m.tool_calls ?? []).some((t) => t.function?.name === tool.name && JSON.stringify(t.function?.arguments ?? {}) === want));
}

/** The reply for one chat request: { content } or { tool_calls }. */
function messageFor(messages, format, tools) {
  const hit = caseFor(messages, format);
  const protocol = !!format?.anyOf;
  if (hit?.tool && (tools?.length || protocol) && !madeCall(messages, hit.tool)) {
    if (tools?.length) return { content: "", tool_calls: [{ function: { name: hit.tool.name, arguments: hit.tool.args ?? {} } }] };
    return { content: JSON.stringify({ tool: hit.tool.name, args: hit.tool.args ?? {} }) };
  }
  const content = hit ? hit.example : answerFor(messages, format);
  if (!protocol) return { content };
  let final = content;
  try {
    final = JSON.parse(content);
  } catch {
    /* a text answer */
  }
  return { content: JSON.stringify({ final }) };
}

/** The cases this request may be asking about, most likely first. */
function candidates(messages, format) {
  const all = messages.map((m) => m.content ?? "").join("\n");
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  // The user's own input wins over text a tool returned (a read_file result can be another case's input).
  const asked = messages.filter((m) => m.role === "user").map((m) => m.content ?? "").join("\n");
  let hits = cases.filter((c) => all.includes(c.key));
  const own = hits.filter((c) => asked.includes(c.key));
  if (own.length) hits = own;
  // Two inputs can share a first line (the committer's file lists): the whole input decides.
  const whole = hits.filter((c) => asked.includes(c.full));
  if (whole.length) hits = whole;
  if (hits.length > 1 && format && Array.isArray(format.required)) {
    hits = hits.filter((c) => {
      try {
        const v = JSON.parse(c.example);
        return format.required.every((k) => k in v);
      } catch {
        return false;
      }
    });
  }
  if (hits.length > 1) {
    // The first agent (in AGENT_HINTS order) whose hint the system prompt matches:
    // one prompt can mention another agent's word (the translator's says "headings").
    const agent = Object.keys(AGENT_HINTS).find((a) => AGENT_HINTS[a].test(system) && hits.some((c) => c.agent.split("-")[0] === a));
    if (agent) hits = hits.filter((c) => c.agent.split("-")[0] === agent);
  }
  return hits;
}

function caseFor(messages, format) {
  const hits = candidates(messages, format);
  return hits[0] ?? null;
}

function answerFor(messages, format) {
  const hits = candidates(messages, format);
  if (hits.length) return hits[0].example;
  if (format) return JSON.stringify({ tags: ["fake"], headings: [], links: [], issues: [], series: [{ type: "bar", data: [1] }], xAxis: { data: ["a"] }, yAxis: {} });
  return "- [ ] fake answer";
}

function embed(text) {
  const h = createHash("sha256").update(text).digest();
  const v = Array.from({ length: 64 }, (_, i) => (h[i % h.length] - 128) / 128);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const origin = req.headers.origin;
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return res.end();
    res.setHeader("content-type", "application/json");
    const url = req.url.split("?")[0];
    if (url === "/api/tags") return res.end(JSON.stringify({ models: MODELS }));
    // `lumen_fake` lets the eval label its report as a wiring run, never as a model score.
    if (url === "/api/version") return res.end(JSON.stringify({ version: "0.12.0", lumen_fake: true }));
    if (url === "/api/show") return res.end(JSON.stringify({ capabilities: ["completion", "tools"] }));
    if (url === "/api/embed") {
      const j = JSON.parse(body || "{}");
      const input = Array.isArray(j.input) ? j.input : [j.input ?? ""];
      return res.end(JSON.stringify({ embeddings: input.map(embed) }));
    }
    if (url === "/api/pull") {
      // Two layers in four steps, then "success" — the shape of a real
      // pull (plan 5.7). A name with "missing" fails like an unknown model.
      const j = JSON.parse(body || "{}");
      const name = String(j.model ?? j.name ?? "");
      res.setHeader("content-type", "application/x-ndjson");
      const send = (o) => res.write(JSON.stringify(o) + "\n");
      send({ status: "pulling manifest" });
      if (!name || name.includes("missing")) return res.end(JSON.stringify({ error: "pull model manifest: file does not exist" }) + "\n");
      const layers = [{ digest: "sha256:aaa", total: 4_000_000 }, { digest: "sha256:bbb", total: 1_000 }];
      for (const l of layers) for (const f of [0, 0.5, 1]) send({ status: `pulling ${l.digest.slice(7, 19)}`, digest: l.digest, total: l.total, completed: Math.round(l.total * f) });
      send({ status: "verifying sha256 digest" });
      send({ status: "writing manifest" });
      if (!MODELS.some((m) => m.name === name)) MODELS.push({ name, details: { parameter_size: "4B", family: "fake" } });
      return res.end(JSON.stringify({ status: "success" }) + "\n");
    }
    if (url === "/api/delete") {
      const j = JSON.parse(body || "{}");
      const i = MODELS.findIndex((m) => m.name === String(j.model ?? j.name ?? ""));
      if (i < 0) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: "model not found" }));
      }
      MODELS.splice(i, 1);
      return res.end("{}");
    }
    if (url === "/api/chat") {
      const j = JSON.parse(body || "{}");
      const message = { role: "assistant", ...messageFor(j.messages ?? [], j.format, j.tools) };
      const usage = { prompt_eval_count: 10, eval_count: 10 };
      if (j.stream) {
        res.setHeader("content-type", "application/x-ndjson");
        res.write(JSON.stringify({ message }) + "\n");
        return res.end(JSON.stringify({ done: true, ...usage }) + "\n");
      }
      return res.end(JSON.stringify({ message, done: true, ...usage }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
});
server.listen(port, () => {
  // hygiene-allow: a CLI fixture announcing its port
  console.log(`fake ollama: http://localhost:${port} (${cases.length} fixture answers)`);
});
