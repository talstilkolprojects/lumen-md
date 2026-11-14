#!/usr/bin/env node
// A fake Ollama server for tests: answers /api/tags, /api/version, /api/show,
// /api/chat, /api/embed, /api/pull (streamed progress) and /api/delete over real HTTP, so the app's local-AI path can be
// exercised in CI without a GPU or a model download.
//
//   npm run fake-ollama -- [--port 11434] [--fixtures src/agents/eval/fixtures.ts]
//
// Chat answers come from the eval fixtures: the first case whose input text
// appears in the prompt wins; anything else gets a generic JSON/text answer.
// Embeddings are deterministic hashes, so equal texts give equal vectors.
import http from "node:http";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const opt = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};
const port = Number(opt("--port", process.env.FAKE_OLLAMA_PORT || 11434));
const fixturesPath = opt("--fixtures", "src/agents/eval/fixtures.ts");

// The fixtures are TypeScript; Node ≥ 22.6 strips the types on import
// (`--experimental-strip-types`, which the npm script passes).
let cases = [];
try {
  const mod = await import(new URL(fixturesPath, `file://${process.cwd()}/`).href);
  cases = (mod.EVAL_CASES ?? []).map((c) => ({ id: c.id, key: String(c.input.text ?? "").slice(0, 40), example: c.example }));
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
  writer: /writing assistant|continue|ghostwriter/i,
};

function answerFor(messages, format) {
  const all = messages.map((m) => m.content ?? "").join("\n");
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  let hits = cases.filter((c) => all.includes(c.key));
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
    const byAgent = hits.filter((c) => AGENT_HINTS[c.id.split("-")[0]]?.test(system));
    if (byAgent.length) hits = byAgent;
  }
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
    if (url === "/api/version") return res.end(JSON.stringify({ version: "0.12.0" }));
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
      const content = answerFor(j.messages ?? [], j.format);
      const usage = { prompt_eval_count: 10, eval_count: 10 };
      if (j.stream) {
        res.setHeader("content-type", "application/x-ndjson");
        res.write(JSON.stringify({ message: { role: "assistant", content } }) + "\n");
        return res.end(JSON.stringify({ done: true, ...usage }) + "\n");
      }
      return res.end(JSON.stringify({ message: { role: "assistant", content }, done: true, ...usage }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
});
server.listen(port, () => {
  // hygiene-allow: a CLI fixture announcing its port
  console.log(`fake ollama: http://localhost:${port} (${cases.length} fixture answers)`);
});
