/**
 * Web Playground runner — the page inside the block's sandboxed iframe
 * (`sandbox="allow-scripts"`, no same-origin: an opaque origin with no
 * access to the app's storage, cookies or DOM). It receives one project per
 * load, transpiles JSX / TypeScript with Sucrase, links the files as blob
 * ES modules, provides react / react-dom / vue from self-hosted copies
 * (/playground/vendor/, no CDN), runs the entry module, and reports console
 * output and errors back to the page.
 */
import { transform } from "sucrase";
import {
  IMPORT_ATTRS_RE,
  circularImportMessage,
  formatValue,
  LOOP_GUARD,
  guardLoops,
  importSpecifiers,
  resolveImport,
  type PlaygroundProject,
  type RunnerMessage,
  type RunnerRequest,
} from "./files";

// Beneath Vite's base (a subpath deployment serves them at /app/playground/…).
const vendor = (file: string) => new URL(`${import.meta.env.BASE_URL}playground/vendor/${file}`, location.href).href;
let runId = 0;
const post = (msg: RunnerMessage) => parent.postMessage(msg, "*");

function show(value: unknown, max = MAX_TEXT): string {
  if (typeof value === "string") return value.slice(0, max);
  if (value instanceof Error) {
    const head = `${value.name}: ${value.message}`;
    // Firefox / Safari stacks don't start with the message.
    if (!value.stack) return head;
    return value.stack.includes(value.message) ? value.stack : `${head}\n${value.stack}`;
  }
  // Bounded: a huge object stops being walked once the cap is reached.
  return formatValue(value, max);
}

/** A console call's arguments, formatted within one shared character budget. */
function showArgs(args: unknown[]): string {
  let out = "";
  for (const a of args) {
    const left = MAX_TEXT - out.length;
    if (left <= 0) break;
    out += (out ? " " : "") + show(a, left);
  }
  return out.slice(0, MAX_TEXT);
}

const MAX_TEXT = 10_000;
const MAX_CONSOLE = 500;
let sent = 0;
for (const level of ["log", "info", "warn", "error"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    orig(...args);
    if (sent++ < MAX_CONSOLE) post({ type: "console", runId, level, text: showArgs(args) });
  };
}
// Errors share the console's budget and size cap, so a huge thrown value
// can't flood the parent.
const postError = (message: string) => {
  if (sent++ < MAX_CONSOLE) post({ type: "error", runId, message: String(message).slice(0, MAX_TEXT) });
};
addEventListener("error", (e) => postError(e.error ? show(e.error) : e.message));
addEventListener("unhandledrejection", (e) => postError(show(e.reason)));

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
const blob = (code: string) => URL.createObjectURL(new Blob([code], { type: "text/javascript" }));

/** An ES module re-exporting a global (React / ReactDOM). */
function globalModule(name: string, extra = ""): string {
  const g = (window as unknown as Record<string, Record<string, unknown> | undefined>)[name];
  if (!g) throw new Error(`${name} is not loaded`);
  const keys = Object.keys(g).filter((k) => IDENT_RE.test(k) && k !== "default");
  return `const G = window.${name};\nexport default G;\n${keys.length ? `export const { ${keys.join(", ")} } = G;\n` : ""}${extra}`;
}

async function providedModules(framework: PlaygroundProject["framework"]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (framework === "react") {
    await loadScript(vendor("react.production.min.js"));
    await loadScript(vendor("react-dom.production.min.js"));
    out.react = blob(globalModule("React"));
    out["react-dom"] = blob(globalModule("ReactDOM"));
    out["react-dom/client"] = out["react-dom"];
    // Automatic JSX runtime on top of createElement.
    out["react/jsx-runtime"] = blob(
      [
        "const R = window.React;",
        "export const Fragment = R.Fragment;",
        "export function jsx(type, props, key) {",
        "  const { children, ...rest } = props || {};",
        "  if (key !== undefined) rest.key = key;",
        "  return children === undefined ? R.createElement(type, rest)",
        "    : Array.isArray(children) ? R.createElement(type, rest, ...children)",
        "    : R.createElement(type, rest, children);",
        "}",
        "export const jsxs = jsx;",
        "export const jsxDEV = jsx;",
      ].join("\n"),
    );
  }
  out.vue = vendor("vue.esm-browser.prod.js");
  return out;
}


async function link(project: PlaygroundProject): Promise<string> {
  const provided = await providedModules(project.framework);
  const names = project.files.map((f) => f.name);
  const urls = new Map<string, string>();
  /** The files being linked, outermost first (to name a cycle). */
  const visiting: string[] = [];
  const build = (name: string): string => {
    const done = urls.get(name);
    if (done) return done;
    if (visiting.includes(name)) throw new Error(circularImportMessage(visiting, name));
    visiting.push(name);
    const file = project.files.find((f) => f.name === name)!;
    let code = file.code;
    if (/\.css$/i.test(name)) code = `export default ${JSON.stringify(file.code)};`;
    else if (/\.json$/i.test(name)) code = `export default ${file.code};`;
    else {
      const ts = /\.tsx?$/i.test(name);
      const jsx = /\.(jsx|tsx)$/i.test(name) || (project.framework === "react" && /\.js$/i.test(name));
      code = transform(code, {
        transforms: [...(ts ? (["typescript"] as const) : []), ...(jsx ? (["jsx"] as const) : [])],
        jsxRuntime: project.framework === "react" ? "automatic" : "classic",
        production: true,
        filePath: name,
      }).code;
      code = guardLoops(code);
    }
    // Only real import / re-export specifiers (not text in comments or
    // strings), replaced from the end so offsets stay valid.
    for (const { start, end, spec } of importSpecifiers(code).reverse()) {
      let url: string;
      let rest = code.slice(end);
      if (spec in provided) url = provided[spec];
      else {
        const target = resolveImport(spec, name, names);
        // JSON and CSS files become JavaScript modules here: drop the
        // import attributes (`with { type: "json" }`) that would reject them.
        if (target && /\.(json|css)$/i.test(target)) rest = rest.replace(IMPORT_ATTRS_RE, "");
        if (target) url = build(target);
        else if (/^(\.|\/)/.test(spec)) throw new Error(`${name}: can't find "${spec}"`);
        else throw new Error(`${name}: package "${spec}" isn't available here (react, react-dom, vue are)`);
      }
      code = code.slice(0, start) + JSON.stringify(url) + rest;
    }
    const url = blob(code + `\n//# sourceURL=${name}`);
    urls.set(name, url);
    visiting.pop();
    return url;
  };
  if (!project.entry) throw new Error("No script to run: add a main.js / main.jsx file");
  return build(project.entry);
}

/*
 * Runaway loops: the iframe may share the editor's thread, so a loop that
 * never yields would freeze the whole app. Every loop condition calls the
 * guard (see guardLoops); a heartbeat marks each time the event loop turns.
 * If the page has been busy for 5 s without turning, the loop throws.
 */
const BUSY_LIMIT_MS = 5000;
let lastTurn = performance.now();
setInterval(() => (lastTurn = performance.now()), 100);
let loopCalls = 0;
(globalThis as unknown as Record<string, () => boolean>)[LOOP_GUARD] = () => {
  if ((++loopCalls & 0x3ff) === 0 && performance.now() - lastTurn > BUSY_LIMIT_MS) {
    lastTurn = performance.now(); // let the error be reported, then the next loop run
    throw new Error(`Stopped a loop that kept the page busy for over ${BUSY_LIMIT_MS / 1000} s`);
  }
  return true;
};

async function run(project: PlaygroundProject): Promise<void> {
  const started = performance.now();
  for (const css of project.css) {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
  }
  // The project's own markup (scripts inside it don't run: use files).
  const tpl = document.createElement("template");
  tpl.innerHTML = project.html;
  tpl.content.querySelectorAll("script").forEach((s) => s.remove());
  document.body.replaceChildren(tpl.content);
  try {
    const entry = await link(project);
    await import(/* @vite-ignore */ entry);
  } catch (err) {
    post({ type: "error", runId, message: show(err) });
  }
  // Let synchronous render work settle before reporting.
  setTimeout(() => post({ type: "done", runId, ms: Math.round(performance.now() - started) }), 0);
}

let started = false;
addEventListener("message", (e: MessageEvent<RunnerRequest>) => {
  if (e.source !== parent || started || e.data?.type !== "run") return;
  started = true; // one project per load: the page reloads the frame to re-run
  runId = e.data.runId;
  if (!e.data.project?.files?.every((f) => typeof f.code === "string" && typeof f.name === "string")) return;
  void run(e.data.project);
});
post({ type: "ready" });

