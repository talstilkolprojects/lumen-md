#!/usr/bin/env node
/**
 * Security headers from one source (plan 0.17).
 *
 * security/policy.json holds the Content-Security-Policy of every route
 * (the app, the two runner pages, the OCR worker, the workers that need
 * eval) as structured directives, the other security headers, and the
 * per-host differences that are legitimate (meta cannot carry
 * frame-ancestors, Tauri needs its IPC protocol, …). This script renders
 * that policy into every file that carries a copy:
 *
 *   public/_headers                      Cloudflare Pages / Netlify
 *   netlify/edge-functions/runner-headers.ts  Netlify: the runner pages' own policy
 *   deploy/vercel.base.json              Vercel (read through vercel.ts)
 *   deploy/nginx.conf (+ runtime include) the one nginx image (Dockerfile: fly.toml and docker-compose.yml)
 *   index.html, livejs-runner.html,      <meta http-equiv> copies
 *   playground-runner.html
 *   src-tauri/tauri.conf.json            desktop app
 *
 *   node scripts/headers.mjs [--check]   exit 1 + a readable diff when a source differs
 *   node scripts/headers.mjs --write     rewrite the policy values in place
 *   node scripts/headers.mjs --tauri-config dist/.csp-connect-extra
 *                                        print `tauri build --config` JSON whose CSP adds
 *                                        the deployment's endpoint origins (desktop builds)
 *
 * --write replaces only the header values (each file keeps its structure,
 * comments and formatting). What it cannot fix — a route with no block in a
 * file, a CSP that applies to the wrong route, a required header missing —
 * is reported and must be added by hand once.
 *
 * Build-time endpoint origins (src/build/cspEndpoints.ts) are added to the
 * built copies (dist/index.html, dist/_headers, the nginx and Vercel placeholders), not
 * to these sources, so this check and that extension never fight.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const POLICY_FILE = "security/policy.json";
export const CSP = "Content-Security-Policy";
/** Hosts that send real response headers (meta / tauri carry only a CSP). */
const HEADER_HOSTS = new Set(["cloudflare", "netlify", "vercel", "deploy-nginx"]);

export function loadPolicy(root = ROOT) {
  return JSON.parse(readFileSync(join(root, POLICY_FILE), "utf8"));
}

// ───────────────────────────── CSP model ─────────────────────────────

/** Parse a CSP string into an ordered Map of directive → source list. */
export function parseCsp(text) {
  const out = new Map();
  for (const part of String(text).split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const [name, ...values] = tokens;
    out.set(name.toLowerCase(), values);
  }
  return out;
}

function ruleApplies(rule, route) {
  return rule.routes === "*" || (Array.isArray(rule.routes) && rule.routes.includes(route));
}

/**
 * Directives of `route` as served by `host`, after the host's documented
 * exceptions: `omit` drops whole directives, `remove` drops single sources
 * from a directive, `add` appends sources (in that order).
 */
export function directivesFor(policy, route, host) {
  const def = policy.routes[route];
  if (!def) throw new Error(`security/policy.json: unknown route "${route}"`);
  const map = new Map(Object.entries(def.csp).map(([k, v]) => [k, [...v]]));
  for (const rule of policy.hosts?.[host]?.csp ?? []) {
    if (!ruleApplies(rule, route)) continue;
    for (const name of rule.omit ?? []) map.delete(name);
    for (const [name, values] of Object.entries(rule.remove ?? {})) {
      const list = map.get(name);
      if (list) map.set(name, list.filter((v) => !values.includes(v)));
    }
    for (const [name, values] of Object.entries(rule.add ?? {})) {
      const list = map.get(name);
      if (!list) {
        map.set(name, [...values]);
        continue;
      }
      for (const v of values) if (!list.includes(v)) list.push(v);
    }
  }
  return map;
}

/** The policy as one header value: `a x y; b z` (no trailing separator). */
export function renderCsp(policy, route, host) {
  return [...directivesFor(policy, route, host)]
    .map(([name, values]) => (values.length ? `${name} ${values.join(" ")}` : name))
    .join("; ");
}

/**
 * The CSP of `route` as the header lines a `_headers` file carries for
 * `host`. Usually one value. A `hosts.<host>.split` rule sends it as two
 * policies instead (the host joins two lines of one rule with a comma): the
 * first with the split directive widened to `superset`, the second with
 * only that directive. A browser enforces both, so their intersection is
 * exactly renderCsp(), and each line stays under the host's line limit.
 */
export function renderCspParts(policy, route, host) {
  const map = directivesFor(policy, route, host);
  const render = (m) => [...m].map(([name, values]) => (values.length ? `${name} ${values.join(" ")}` : name)).join("; ");
  const rule = (policy.hosts?.[host]?.split ?? []).find((r) => ruleApplies(r, route) && map.has(r.directive));
  if (!rule) return [render(map)];
  const own = map.get(rule.directive);
  const wide = new Map([...map].map(([k, v]) => [k, k === rule.directive ? [...rule.superset] : v]));
  return [render(wide), render(new Map([[rule.directive, own]]))];
}

/**
 * One policy from the comma-joined policies of a CSP header, for the split
 * form renderCspParts() writes: a directive whose source list is the split
 * rule's superset in one policy takes its list from the other. Anything else
 * (two real lists for one directive) is kept as the first policy's list and
 * reported in `conflicts`.
 */
export function combineCspParts(values, superset = ["'self'", "blob:", "data:", "https:", "http:", "wss:", "ws:"]) {
  const isSuperset = (list) => list.length === superset.length && superset.every((s) => list.includes(s));
  const out = new Map();
  const conflicts = [];
  for (const value of values.flatMap((v) => String(v).split(","))) {
    for (const [name, list] of parseCsp(value)) {
      const prev = out.get(name);
      if (!prev || isSuperset(prev)) out.set(name, list);
      else if (!isSuperset(list) && prev.join(" ") !== list.join(" ")) conflicts.push(name);
    }
  }
  return { policy: out, conflicts };
}

/** The sample paths of `route` on `host`: the route's own plus the host's extra ones. */
export function samplesFor(policy, route, host) {
  return [...(policy.routes[route]?.samples ?? []), ...(policy.hosts?.[host]?.samples?.[route] ?? [])];
}

/** `_headers` line body. */
export const renderHeaderLine = (policy, route, host = "cloudflare") => `${CSP}: ${renderCsp(policy, route, host)}`;
/** `<meta http-equiv>` content (no frame-ancestors, see hosts.meta). */
export const renderMeta = (policy, route) => renderCsp(policy, route, "meta");
/** nginx directive. */
export const renderNginx = (policy, route, host = "docker-nginx") =>
  `add_header ${CSP} "${renderCsp(policy, route, host)}" always;`;
/** deploy/vercel.base.json header object. */
export const renderVercel = (policy, route) => ({ key: CSP, value: renderCsp(policy, route, "vercel") });
/** tauri.conf.json app.security.csp. */
export const renderTauri = (policy) => renderCsp(policy, "app", "tauri");

/**
 * `tauri build --config` JSON for a desktop build with deployment endpoints.
 * tauri.conf.json holds the explicit public list only; the origins the Vite
 * build added to index.html (`dist/.csp-connect-extra`, one space-separated
 * line) join its connect-src here, so the compiled policy matches the meta.
 */
export function tauriConfigWithOrigins(policy, origins) {
  const map = directivesFor(policy, "app", "tauri");
  const connect = map.get("connect-src");
  for (const o of origins) if (connect && !connect.includes(o)) connect.push(o);
  const csp = [...map].map(([name, values]) => (values.length ? `${name} ${values.join(" ")}` : name)).join("; ");
  return { app: { security: { csp } } };
}

/** Canonical value of a non-CSP security header on `host`, or undefined when that host does not send it. */
export function headerValue(policy, name, host) {
  const def = findHeader(policy, name);
  if (!def) return undefined;
  if (def[1].hosts && !def[1].hosts.includes(host)) return undefined;
  return def[1].value;
}

function findHeader(policy, name) {
  const lower = name.toLowerCase();
  return Object.entries(policy.headers ?? {}).find(([k]) => k.toLowerCase() === lower);
}

const isManaged = (policy, name) => name.toLowerCase() === CSP.toLowerCase() || !!findHeader(policy, name);
const canonicalName = (policy, name) =>
  name.toLowerCase() === CSP.toLowerCase() ? CSP : findHeader(policy, name)?.[0] ?? name;

/** Headers a route must carry on `host` (name → { absent?: true }). */
function requiredHeaders(policy, route, host) {
  const def = policy.routes[route];
  const out = new Map();
  for (const [name, h] of Object.entries(policy.headers ?? {})) {
    const req = h.required;
    if (!req || !req.kinds?.includes(def.kind)) continue;
    if (h.hosts && !h.hosts.includes(host)) continue;
    out.set(name, req.notFrameable && def.frameable ? { absent: true } : {});
  }
  return out;
}

/** Directive-level difference, `-` = only in the file, `+` = only in the policy. */
export function cspDiff(actual, expected) {
  const a = parseCsp(actual);
  const e = parseCsp(expected);
  const lines = [];
  for (const [d, vals] of e) {
    const av = a.get(d);
    if (!av) {
      lines.push(`+ ${d} ${vals.join(" ")}`);
      continue;
    }
    const extra = av.filter((v) => !vals.includes(v));
    const missing = vals.filter((v) => !av.includes(v));
    if (extra.length) lines.push(`- ${d} ${extra.join(" ")}`);
    if (missing.length) lines.push(`+ ${d} ${missing.join(" ")}`);
    if (!extra.length && !missing.length && av.join(" ") !== vals.join(" ")) lines.push(`~ ${d}: source order`);
  }
  for (const [d, vals] of a) if (!e.has(d)) lines.push(`- ${d} ${vals.join(" ")}`);
  if (!lines.length) lines.push("~ formatting only (separators / directive order)");
  return lines;
}

// ───────────────────────────── file scanners ─────────────────────────────
// Each scanner returns slots: { key, name, value, start, end, line, extra? }
// where [start, end) is the value's span in the file text.

const lineAt = (text, offset) => text.slice(0, offset).split("\n").length;

/** Cloudflare/Netlify `_headers`: path blocks of `Name: value` and `! Name` lines. */
export function scanHeadersFile(text) {
  const blocks = [];
  let cur = null;
  let offset = 0;
  for (const raw of text.split("\n")) {
    const lineStart = offset;
    offset += raw.length + 1;
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    if (/^\S/.test(raw)) {
      cur = { path: raw.trim(), items: [], line: lineAt(text, lineStart) };
      blocks.push(cur);
      continue;
    }
    if (!cur) continue;
    const detach = /^\s+!\s*([A-Za-z0-9-]+)\s*$/.exec(raw);
    if (detach) {
      cur.items.push({ type: "detach", name: detach[1] });
      continue;
    }
    const set = /^(\s+)([A-Za-z0-9-]+):[ \t]*/.exec(raw);
    if (!set) continue;
    const valueStart = lineStart + set[0].length;
    const value = raw.slice(set[0].length).replace(/\s+$/, "");
    cur.items.push({
      type: "set",
      slot: { key: cur.path, name: set[2], value, start: valueStart, end: valueStart + value.length, line: lineAt(text, lineStart) },
    });
  }
  return blocks;
}

/**
 * Lines of one rule that set the same header: Cloudflare and Netlify send one
 * header with the values joined by ", " (workers-sdk parseHeaders.ts). They
 * become one item whose slot keeps each line in `parts`.
 */
function joinRepeated(items) {
  const out = [];
  const byName = new Map();
  for (const item of items) {
    if (item.type !== "set") {
      out.push(item);
      continue;
    }
    const lower = item.slot.name.toLowerCase();
    const prev = byName.get(lower);
    if (!prev) {
      const joined = { type: "set", slot: { ...item.slot, parts: [item.slot] } };
      byName.set(lower, joined);
      out.push(joined);
      continue;
    }
    prev.slot.parts.push(item.slot);
    prev.slot.value = prev.slot.parts.map((p) => p.value).join(", ");
  }
  for (const item of out) if (item.type === "set" && item.slot.parts.length === 1) delete item.slot.parts;
  return out;
}

/** Cloudflare path pattern (`*` splat, `:name` placeholder) → RegExp. */
function cfPattern(path) {
  const body = path
    .split(/(\*|:[A-Za-z]\w*)/)
    .map((part) => (part === "*" ? ".*" : part.startsWith(":") ? "[^/]+" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`);
}

/** Minimal JSON reader that records where every string value sits in the text. */
export function locateJson(text) {
  const spans = new Map();
  let i = 0;
  const ws = () => {
    while (/\s/.test(text[i] ?? "")) i++;
  };
  const str = () => {
    const start = i;
    i++;
    while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
    return { value: JSON.parse(text.slice(start, i)), start: start + 1, end: i - 1 };
  };
  const val = (path) => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const obj = {};
      ws();
      if (text[i] === "}") return i++, obj;
      for (;;) {
        ws();
        const k = str().value;
        ws();
        i++; // :
        obj[k] = val([...path, k]);
        ws();
        if (text[i++] === "}") return obj;
      }
    }
    if (c === "[") {
      i++;
      const arr = [];
      ws();
      if (text[i] === "]") return i++, arr;
      for (;;) {
        arr.push(val([...path, arr.length]));
        ws();
        if (text[i++] === "]") return arr;
      }
    }
    if (c === '"') {
      const s = str();
      spans.set(path.join("\u0000"), s);
      return s.value;
    }
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!m) throw new Error(`JSON: unexpected "${c}" at ${i}`);
    i += m[0].length;
    return JSON.parse(m[0]);
  };
  const value = val([]);
  return { value, span: (...path) => spans.get(path.join("\u0000")) };
}

/** nginx: add_header statements with the block they sit in. */
export function scanNginx(text) {
  const stack = [];
  const slots = [];
  const blocks = [];
  let tokens = [];
  let i = 0;
  const flush = (kind) => {
    if (kind === "{") {
      const key = tokens.map((t) => t.text).join(" ");
      stack.push(key);
      blocks.push({ key, line: tokens[0] ? lineAt(text, tokens[0].start) : 0 });
    } else if (kind === "}") {
      stack.pop();
    } else if (tokens[0]?.text === "add_header" && tokens.length >= 3) {
      const v = tokens[2];
      slots.push({
        key: stack[stack.length - 1] ?? "(file)",
        name: tokens[1].text,
        value: v.text,
        start: v.start,
        end: v.end,
        line: lineAt(text, tokens[0].start),
        flags: tokens.slice(3).map((t) => t.text),
      });
    }
    tokens = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === ";" || c === "{" || c === "}") {
      flush(c);
      i++;
    } else if (c === '"' || c === "'") {
      const start = ++i;
      while (i < text.length && text[i] !== c) i += text[i] === "\\" ? 2 : 1;
      tokens.push({ text: text.slice(start, i), start, end: i });
      i++;
    } else {
      const start = i;
      while (i < text.length && !/[\s;{}]/.test(text[i])) i++;
      tokens.push({ text: text.slice(start, i), start, end: i });
    }
  }
  return { slots, blocks };
}

const META_RE = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/gi;

export function scanMeta(text) {
  return [...text.matchAll(META_RE)].map((m) => {
    const start = m.index + m[0].length - 1 - m[1].length;
    return { key: "<meta>", name: CSP, value: m[1], start, end: start + m[1].length, line: lineAt(text, m.index) };
  });
}

// ───────────────────────────── checking ─────────────────────────────

/**
 * Check (and optionally rewrite) every source listed in the policy.
 * Returns { problems: string[], fixes: number, files: string[] }.
 */
export function run({ root = ROOT, write = false, policy = loadPolicy(root) } = {}) {
  const problems = [];
  const files = [];
  let fixes = 0;

  for (const [file, src] of Object.entries(policy.sources)) {
    const path = join(root, file);
    if (!existsSync(path)) {
      problems.push(`${file}: listed in ${POLICY_FILE} but missing`);
      continue;
    }
    const text = readFileSync(path, "utf8");
    const edits = [];
    const where = (slot) => `${file}:${slot.line} [${slot.key}]`;
    /** Compare one slot against its expected value; queue an edit. */
    const expect = (slot, expected, route) => {
      if (slot.value === expected) return;
      const head = `${where(slot)} ${canonicalName(policy, slot.name)}${route ? ` (route ${route})` : ""}`;
      const detail =
        slot.name.toLowerCase() === CSP.toLowerCase()
          ? cspDiff(slot.value, expected)
          : [`- ${slot.value}`, `+ ${expected}`];
      problems.push([head, ...detail.map((l) => `    ${l}`)].join("\n"));
      edits.push({ start: slot.start, end: slot.end, value: expected });
    };
    /** A non-CSP managed header: value must be the host's canonical one. */
    const expectSiteHeader = (slot) => {
      const v = headerValue(policy, slot.name, src.host);
      if (v === undefined) {
        problems.push(`${where(slot)} ${slot.name}: ${POLICY_FILE} says ${src.host} does not send this header`);
        return;
      }
      expect(slot, v);
    };

    if (src.format === "meta" || src.format === "tauri") {
      let slot;
      if (src.format === "meta") {
        const slots = scanMeta(text);
        if (slots.length !== 1) {
          problems.push(`${file}: expected exactly one <meta http-equiv="Content-Security-Policy">, found ${slots.length}`);
          continue;
        }
        slot = slots[0];
      } else {
        const json = locateJson(text);
        const span = json.span("app", "security", "csp");
        if (!span) {
          problems.push(`${file}: app.security.csp not found`);
          continue;
        }
        slot = { key: "app.security.csp", name: CSP, value: span.value, start: span.start, end: span.end, line: lineAt(text, span.start) };
      }
      const expected = renderCsp(policy, src.route, src.host);
      // JSON strings need escaping; CSP values have no quotes or backslashes, but stay safe.
      expect(slot, src.format === "tauri" ? JSON.stringify(expected).slice(1, -1) : expected, src.route);
    } else if (src.format === "nginx") {
      const { slots, blocks } = scanNginx(text);
      const mapped = src.blocks ?? {};
      for (const slot of slots) {
        if (!isManaged(policy, slot.name)) continue;
        if (!slot.flags.includes("always"))
          problems.push(`${where(slot)} add_header ${slot.name}: add \`always\` so error responses carry it too`);
        if (slot.name.toLowerCase() !== CSP.toLowerCase()) {
          expectSiteHeader(slot);
          continue;
        }
        const route = mapped[slot.key];
        if (!route) {
          problems.push(`${where(slot)} ${CSP} in a block ${POLICY_FILE} does not map to a route (sources["${file}"].blocks)`);
          continue;
        }
        expect(slot, renderCsp(policy, route, src.host), route);
      }
      for (const [key, route] of Object.entries(mapped)) {
        if (key !== "(file)" && !blocks.some((b) => b.key === key)) {
          problems.push(`${file}: block \`${key} {\` (route ${route}) not found`);
          continue;
        }
        const here = slots.filter((s) => s.key === key);
        const has = (name) => here.some((s) => s.name.toLowerCase() === name.toLowerCase());
        if (!has(CSP)) problems.push(`${file} [${key}]: no add_header ${CSP} (route ${route}) — add it by hand once`);
        for (const [name, req] of requiredHeaders(policy, route, src.host)) {
          if (req.absent && has(name)) problems.push(`${file} [${key}]: route ${route} is framed by the app — remove ${name}`);
          if (!req.absent && !has(name))
            problems.push(`${file} [${key}]: missing add_header ${name} "${headerValue(policy, name, src.host)}" always; (route ${route})`);
        }
      }
    } else if (src.format === "netlify-edge") {
      // A `"path": "policy",` map in the edge function, one entry per runner route.
      const slots = [];
      for (const m of text.matchAll(/^(\s*)"(\/[^"]+)":\s*"((?:[^"\\]|\\.)*)",?[ \t]*$/gm)) {
        const vi = m[0].lastIndexOf(`"${m[3]}"`);
        const start = m.index + vi + 1;
        slots.push({ key: m[2], name: CSP, value: m[3], start, end: start + m[3].length, line: lineAt(text, m.index) });
      }
      const routes = src.routes ?? {};
      for (const slot of slots) {
        const route = routes[slot.key];
        if (!route) {
          problems.push(`${where(slot)} ${CSP} for a path ${POLICY_FILE} does not map to a route (sources["${file}"].routes)`);
          continue;
        }
        expect(slot, JSON.stringify(renderCsp(policy, route, src.host)).slice(1, -1), route);
      }
      for (const [path2, route] of Object.entries(routes)) {
        if (!slots.some((s) => s.key === path2)) problems.push(`${file}: no "${path2}" entry (route ${route}) — add it by hand once`);
        for (const [name, req] of requiredHeaders(policy, route, src.host)) {
          // The function must drop the catch-all's frame denial; the other headers come from _headers.
          if (req.absent && !new RegExp(`headers\\.delete\\("${name.toLowerCase()}"\\)`).test(text))
            problems.push(`${file}: route ${route} is framed by the app — the function must headers.delete("${name.toLowerCase()}")`);
        }
      }
    } else if (src.format === "headers-file" || src.format === "vercel") {
      // Emulate the host: which header values does each route's sample path get?
      let rules; // [{ key, items: [{type, name, slot?}] , test(path) }]
      let json;
      if (src.format === "headers-file") {
        rules = scanHeadersFile(text).map((b) => ({ key: b.path, items: joinRepeated(b.items), test: (p) => cfPattern(b.path).test(p) }));
        const limit = policy.hosts?.[src.host]?.lineLimit;
        if (limit) {
          text.split("\n").forEach((line, i) => {
            if (line.length > limit)
              problems.push(`${file}:${i + 1}: ${line.length} characters, over ${src.host}'s limit of ${limit} a line (the host skips the line)`);
          });
        }
      } else {
        json = locateJson(text);
        rules = (json.value.headers ?? []).map((entry, i) => ({
          key: entry.source,
          test: (p) => new RegExp(`^${entry.source}$`).test(p),
          items: entry.headers.map((h, j) => {
            const span = json.span("headers", i, "headers", j, "value");
            return {
              type: "set",
              slot: { key: entry.source, name: h.key, value: h.value, start: span.start, end: span.end, line: lineAt(text, span.start) },
            };
          }),
        }));
      }
      const effective = (path) => {
        const out = new Map();
        for (const rule of rules) {
          if (!rule.test(path)) continue;
          for (const item of rule.items) {
            const lower = (item.name ?? item.slot.name).toLowerCase();
            if (item.type === "detach") out.delete(lower);
            else if (out.has(lower)) out.set(lower, { ...item.slot, duplicate: out.get(lower) });
            else out.set(lower, item.slot);
          }
        }
        return out;
      };
      const routesOfSlot = new Map(); // slot → Set(route)
      for (const [route, def] of Object.entries(policy.routes)) {
        for (const sample of samplesFor(policy, route, src.host)) {
          const eff = effective(sample);
          const csp = eff.get(CSP.toLowerCase());
          if (!csp) {
            problems.push(`${file}: ${sample} (route ${route}) gets no ${CSP}`);
            continue;
          }
          if (csp.duplicate) {
            problems.push(
              `${file}: ${sample} (route ${route}) gets two ${CSP} headers ([${csp.duplicate.key}] and [${csp.key}]); detach the general one`,
            );
          }
          const key = `${csp.start}`;
          if (!routesOfSlot.has(key)) routesOfSlot.set(key, { slot: csp, routes: new Map() });
          routesOfSlot.get(key).routes.set(route, sample);
          for (const [name, req] of requiredHeaders(policy, route, src.host)) {
            const got = eff.get(name.toLowerCase());
            if (req.absent && got) problems.push(`${file}: ${sample} (route ${route}) is framed by the app but gets ${name} from [${got.key}]`);
            if (!req.absent && !got) problems.push(`${file}: ${sample} (route ${route}) gets no ${name}`);
          }
        }
      }
      for (const rule of rules) {
        for (const item of rule.items) {
          if (item.type !== "set" || !isManaged(policy, item.slot.name)) continue;
          const slot = item.slot;
          if (slot.name.toLowerCase() !== CSP.toLowerCase()) {
            expectSiteHeader(slot);
            continue;
          }
          const hit = routesOfSlot.get(`${slot.start}`);
          if (!hit) {
            problems.push(`${where(slot)} ${CSP} applies to none of the routes' sample paths in ${POLICY_FILE}`);
            continue;
          }
          if (hit.routes.size > 1) {
            const list = [...hit.routes].map(([r, s]) => `${r} (${s})`).join(", ");
            problems.push(`${where(slot)} ${CSP} applies to several routes: ${list} — give each its own block/entry`);
            continue;
          }
          const [route] = hit.routes.keys();
          if (src.format === "headers-file") {
            const parts = renderCspParts(policy, route, src.host);
            const have = slot.parts ?? [slot];
            if (have.length !== parts.length) {
              problems.push(
                `${where(slot)} ${CSP} (route ${route}): ${have.length} line(s) in the file, ${parts.length} in the policy` +
                  (parts.length > 1 ? ` (hosts.${src.host}.split: one line per policy) — split it by hand once` : " — join them by hand once"),
              );
              continue;
            }
            have.forEach((part, i) => expect(part, parts[i], route));
            continue;
          }
          const expected = renderCsp(policy, route, src.host);
          expect(slot, src.format === "vercel" ? JSON.stringify(expected).slice(1, -1) : expected, route);
        }
      }
    } else {
      problems.push(`${file}: unknown format "${src.format}"`);
      continue;
    }

    files.push(file);
    if (write && edits.length) {
      let out = text;
      for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.value + out.slice(e.end);
      writeFileSync(path, out);
      fixes += edits.length;
    }
  }

  // A <meta> CSP in a root HTML page the policy does not know about.
  for (const name of readdirSync(root).filter((f) => f.endsWith(".html"))) {
    if (policy.sources[name]) continue;
    if (scanMeta(readFileSync(join(root, name), "utf8")).length)
      problems.push(`${name}: has a <meta> ${CSP} that ${POLICY_FILE} does not list under sources`);
  }

  for (const host of Object.keys(policy.hosts ?? {})) {
    if (!HEADER_HOSTS.has(host) && host !== "meta" && host !== "tauri") problems.push(`${POLICY_FILE}: unknown host "${host}"`);
  }
  return { problems, fixes, files };
}

// ───────────────────────────── CLI ─────────────────────────────

function main(argv) {
  const write = argv.includes("--write");
  const rootArg = argv.indexOf("--root");
  const root = rootArg >= 0 ? resolve(argv[rootArg + 1]) : ROOT;
  const tauriArg = argv.indexOf("--tauri-config");
  if (tauriArg >= 0) {
    // node scripts/headers.mjs --tauri-config dist/.csp-connect-extra
    const file = argv[tauriArg + 1];
    if (file && !existsSync(file)) {
      process.stderr.write(`headers: ${file} not found (run the Vite build first; it writes dist/.csp-connect-extra)\n`);
      return 1;
    }
    const origins = file ? readFileSync(file, "utf8").split(/\s+/).filter(Boolean) : [];
    process.stdout.write(JSON.stringify(tauriConfigWithOrigins(loadPolicy(root), origins)));
    return 0;
  }
  let result = run({ root, write });
  if (write && result.fixes) {
    process.stdout.write(`headers: rewrote ${result.fixes} value(s) from ${POLICY_FILE}\n`);
    result = run({ root, write: false });
  }
  if (!result.problems.length) {
    process.stdout.write(`headers: ${result.files.length} sources match ${POLICY_FILE}\n`);
    return 0;
  }
  process.stderr.write(
    `headers: ${result.problems.length} difference(s) from ${POLICY_FILE}` +
      ` ("-" only in the file, "+" only in the policy):\n\n${result.problems.join("\n\n")}\n\n` +
      (write ? "These need a hand edit (see docs/security/headers.md).\n" : "Run `npm run headers:write` to rewrite the values; structural problems need a hand edit.\n"),
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
