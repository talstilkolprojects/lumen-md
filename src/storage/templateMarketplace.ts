/**
 * Templates marketplace client (P3-06).
 *
 * Loads `/public/templates/registry.json` (the same shape as the plugin
 * registry) and exposes:
 *
 *   • `fetchTemplateRegistry()` — list every template available.
 *   • `installTemplate(id)`     — fetch the body, write it as a new file,
 *                                 bump the registry's `downloads` counter
 *                                 in localStorage so the UI can rank by
 *                                 "popular in your workspace".
 *
 * The registry is fetched once per session and cached in module scope so
 * the gallery feels snappy. A "Reload registry" command bypasses the
 * cache when needed.
 */

import { log } from "../lib/logger";
import { connectAllowedByCsp } from "../lib/cspConnect";
import { isOPFSAvailable, listWorkspace, readWorkspaceFile, workspaceHasFile, writeWorkspaceFile } from "./workspace";
import { fetchWithRetry } from "../lib/fetchRetry";
import { getLocale } from "../i18n";

export interface MarketplaceTemplate {
  id: string;
  name: string;
  category: string;
  author: string;
  description: string;
  icon: string;
  version: string;
  url: string;
  rating: number;
  downloads: number;
  tags: string[];
  /** Hebrew name / description / body (T45), used when the UI is Hebrew. */
  name_he?: string;
  description_he?: string;
  url_he?: string;
  /**
   * A companion Obsidian Bases view (W3.6): `.base` file URL and the name it
   * is installed under (`Bases/<base_name>.base`), with Hebrew twins.
   */
  base?: string;
  base_he?: string;
  base_name?: string;
  base_name_he?: string;
}

/** The template as the current UI language should show it. */
export function localizeTemplate(tpl: MarketplaceTemplate, locale: string = getLocale()): MarketplaceTemplate {
  if (locale !== "he" || !tpl.url_he) return tpl;
  return {
    ...tpl,
    name: tpl.name_he ?? tpl.name,
    description: tpl.description_he ?? tpl.description,
    url: tpl.url_he,
    base: tpl.base_he ?? tpl.base,
    base_name: tpl.base_name_he ?? tpl.base_name,
  };
}

/** Folder in the workspace where a template's companion `.base` goes. */
export const INSTALLED_BASES_DIR = "Bases";

interface Registry {
  version: number;
  updated: string;
  templates: MarketplaceTemplate[];
}

const LOCAL_DOWNLOADS_KEY = "lumen.templates.downloads";

let cache: Registry | null = null;

export async function fetchTemplateRegistry(force = false): Promise<MarketplaceTemplate[]> {
  if (cache && !force) return mergeLocalDownloads(cache.templates).map((tpl) => localizeTemplate(tpl));
  const res = await fetchWithRetry("/templates/registry.json", { cache: "no-cache" }, { label: "templates.registry", maxRetries: 2, baseDelayMs: 600 });
  if (!res.ok) throw new Error(`Registry ${res.status}`);
  cache = (await res.json()) as Registry;
  return mergeLocalDownloads(cache.templates).map((tpl) => localizeTemplate(tpl));
}

const absoluteUrl = (url: string) => (url.startsWith("/") || /^https?:\/\//.test(url) ? url : `/${url}`);

/** A name that is safe as one path segment (letters of any script kept). */
export function safeFileStem(name: string): string {
  return name
    .normalize("NFC")
    .replace(/\.(md|markdown|base)$/i, "")
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim();
}

/**
 * Pull the body of `template` from its `url`, save it under
 * `templates/<id>.md` in the workspace, and increment the local download
 * counter so the gallery can re-rank. A companion `.base` (W3.6) goes to
 * `Bases/` beside it.
 */
export async function installTemplate(
  template: MarketplaceTemplate,
): Promise<{ path: string; bytes: number; basePath?: string }> {
  const res = await fetchWithRetry(absoluteUrl(template.url), { cache: "no-cache" }, { label: "templates.install", maxRetries: 2, baseDelayMs: 700, maxDelayMs: 2500 });
  if (!res.ok) throw new Error(`Template ${res.status}`);
  const body = await res.text();
  const path = `templates/${template.id}.md`;
  await writeWorkspaceFile(path, body);
  const basePath = await installCompanionBase(template);
  bumpDownloads(template.id);
  rememberInstalledName(template.id, template.name);
  void recordRemoteInstall(template.id);
  notifyInstalledTemplatesChanged();
  return basePath ? { path, bytes: body.length, basePath } : { path, bytes: body.length };
}

/**
 * Write the template's companion `.base` to `Bases/<base_name>.base` — once:
 * an existing file (the user may have edited its view) is never replaced.
 * Best-effort: a failed fetch leaves the template installed without it.
 */
async function installCompanionBase(template: MarketplaceTemplate): Promise<string | undefined> {
  if (!template.base) return undefined;
  const stem = safeFileStem(template.base_name || template.name) || template.id;
  const path = `${INSTALLED_BASES_DIR}/${stem}.base`;
  try {
    if (await workspaceHasFile(path)) return path;
    const res = await fetchWithRetry(absoluteUrl(template.base), { cache: "no-cache" }, { label: "templates.base", maxRetries: 1, baseDelayMs: 500 });
    if (!res.ok) throw new Error(`Base ${res.status}`);
    await writeWorkspaceFile(path, await res.text());
    if (typeof window !== "undefined") window.dispatchEvent(new Event("lumen-workspace-changed"));
    return path;
  } catch (e) {
    log.warn("templates: companion base not installed", e);
    return undefined;
  }
}

/**
 * Import a template from a Markdown file the user picked: copy it into
 * `templates/` under a safe, unused name ("Recipe.md" → `templates/Recipe.md`,
 * then `Recipe 2.md`…), so it shows in ⌘K next to the gallery's templates.
 */
export async function importTemplateFile(fileName: string, text: string): Promise<InstalledTemplate> {
  if (!/\.(md|markdown)$/i.test(fileName)) throw new Error("not a Markdown file");
  const stem = safeFileStem(fileName) || "Template";
  let id = stem;
  for (let n = 2; await workspaceHasFile(`${INSTALLED_TEMPLATES_DIR}/${id}.md`); n++) id = `${stem} ${n}`;
  const path = `${INSTALLED_TEMPLATES_DIR}/${id}.md`;
  await writeWorkspaceFile(path, text);
  rememberInstalledName(id, id);
  notifyInstalledTemplatesChanged();
  return { id, name: id, path };
}

/* ─── Installed templates (OPFS `templates/<id>.md`) ───────────────── */

/** Folder in the workspace where `installTemplate()` writes bodies. */
export const INSTALLED_TEMPLATES_DIR = "templates";
/** Window event fired after an install so listeners (⌘K) can refresh. */
export const TEMPLATES_CHANGED_EVENT = "lumen:templates-changed";
const INSTALLED_NAMES_KEY = "lumen.templates.installedNames";

export interface InstalledTemplate {
  id: string;
  /** Display name (registry name captured at install time, else derived from the id). */
  name: string;
  /** Workspace path, e.g. `templates/weekly-review.md`. */
  path: string;
}

function readInstalledNames(): Record<string, string> {
  try {
    const raw = localStorage.getItem(INSTALLED_NAMES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function rememberInstalledName(id: string, name: string): void {
  try {
    const names = readInstalledNames();
    names[id] = name;
    localStorage.setItem(INSTALLED_NAMES_KEY, JSON.stringify(names));
  } catch {
    /* why: private mode — fall back to an id-derived name */
  }
}

function notifyInstalledTemplatesChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(TEMPLATES_CHANGED_EVENT));
}

function nameFromId(id: string): string {
  const words = id.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : id;
}

/**
 * List templates installed from the marketplace — every `*.md` file directly
 * inside the workspace `templates/` folder. Returns `[]` when OPFS is
 * unavailable or the folder doesn't exist yet. Sorted by name.
 */
export async function listInstalledTemplates(): Promise<InstalledTemplate[]> {
  if (!isOPFSAvailable()) return [];
  let entries: Awaited<ReturnType<typeof listWorkspace>>;
  try {
    entries = await listWorkspace();
  } catch {
    return [];
  }
  const names = readInstalledNames();
  const prefix = `${INSTALLED_TEMPLATES_DIR}/`;
  const out: InstalledTemplate[] = [];
  for (const e of entries) {
    if (!e.path.startsWith(prefix)) continue;
    const rest = e.path.slice(prefix.length);
    if (rest.includes("/") || !/\.md$/i.test(rest)) continue;
    const id = rest.replace(/\.md$/i, "");
    out.push({ id, name: names[id] || nameFromId(id), path: e.path });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Read the markdown body of an installed template. */
export async function readInstalledTemplate(tpl: Pick<InstalledTemplate, "path">): Promise<string> {
  return readWorkspaceFile(tpl.path);
}

function bumpDownloads(id: string): void {
  try {
    const raw = localStorage.getItem(LOCAL_DOWNLOADS_KEY);
    const parsed: Record<string, number> = raw ? JSON.parse(raw) : {};
    parsed[id] = (parsed[id] ?? 0) + 1;
    localStorage.setItem(LOCAL_DOWNLOADS_KEY, JSON.stringify(parsed));
  } catch {
    /* why: private mode — counter is best-effort */
  }
}

function mergeLocalDownloads(templates: MarketplaceTemplate[]): MarketplaceTemplate[] {
  let local: Record<string, number> = {};
  try {
    const raw = localStorage.getItem(LOCAL_DOWNLOADS_KEY);
    local = raw ? JSON.parse(raw) : {};
  } catch {
    /* why: storage denied or corrupt counter: show the server counts only */
  }
  return templates.map((t) => ({
    ...t,
    downloads: t.downloads + (local[t.id] ?? 0),
  }));
}

/* ─── Real marketplace backend (marketplace-server) ────────────────── */

const BACKEND_KEY = "lumen.marketplace.url";

/** Configured marketplace backend base URL, or null for offline/static mode. */
export function getMarketplaceBackendUrl(): string | null {
  try {
    const fromStorage = localStorage.getItem(BACKEND_KEY);
    if (fromStorage) {
      const url = fromStorage.replace(/\/+$/, "");
      // A runtime override the page's CSP doesn't allow would be blocked by
      // the browser; say so and fall back instead of failing silently.
      if (connectAllowedByCsp(url)) return url;
      log.warn(
        `Ignoring ${BACKEND_KEY}=${url}: its origin isn't in this deployment's CSP connect-src. ` +
          "Set VITE_MARKETPLACE_URL (or VITE_CSP_CONNECT_EXTRA) at build time to allow it.",
      );
    }
  } catch {
    /* why: private mode */
  }
  const env = (import.meta as ImportMeta & { env?: { VITE_MARKETPLACE_URL?: string } }).env
    ?.VITE_MARKETPLACE_URL;
  return env ? env.replace(/\/+$/, "") : null;
}

interface BackendItem {
  id: string;
  type: string;
  name: string;
  description: string;
  author: string;
  version: string;
  url: string;
  tags: string[];
  downloads: number;
  rating: number;
}

function toTemplate(it: BackendItem): MarketplaceTemplate {
  return {
    id: it.id,
    name: it.name,
    category: it.type,
    author: it.author,
    description: it.description,
    icon: "🧩",
    version: it.version,
    url: it.url,
    rating: it.rating,
    downloads: it.downloads,
    tags: it.tags ?? [],
  };
}

/**
 * List marketplace items from the REAL backend when one is configured
 * (`localStorage["lumen.marketplace.url"]` or `VITE_MARKETPLACE_URL`); falls
 * back to the bundled static registry so the gallery still works offline.
 */
export async function fetchMarketplaceItems(
  opts: { type?: string; query?: string } = {},
): Promise<MarketplaceTemplate[]> {
  const backend = getMarketplaceBackendUrl();
  if (!backend) return fetchTemplateRegistry();
  const params = new URLSearchParams();
  if (opts.type) params.set("type", opts.type);
  if (opts.query) params.set("q", opts.query);
  const qs = params.toString();
  const res = await fetchWithRetry(
    `${backend}/items${qs ? `?${qs}` : ""}`,
    { cache: "no-cache" },
    { label: "marketplace.list", maxRetries: 2, baseDelayMs: 600 },
  );
  if (!res.ok) throw new Error(`Marketplace ${res.status}`);
  return ((await res.json()) as BackendItem[]).map(toTemplate);
}

/** Record a real install against the backend (best-effort; no-op offline). */
export async function recordRemoteInstall(id: string): Promise<void> {
  const backend = getMarketplaceBackendUrl();
  if (!backend) return;
  try {
    await fetch(`${backend}/items/${encodeURIComponent(id)}/install`, { method: "POST" });
  } catch {
    /* why: the install counter is best effort; the template is installed either way */
  }
}

/** Publish (or update) an item on the marketplace backend. */
export async function publishToMarketplace(item: {
  id: string;
  type: "template" | "plugin" | "theme";
  name: string;
  [k: string]: unknown;
}): Promise<MarketplaceTemplate> {
  const backend = getMarketplaceBackendUrl();
  if (!backend) throw new Error("No marketplace backend configured");
  const res = await fetch(`${backend}/items`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(item),
  });
  if (!res.ok) throw new Error(`Publish ${res.status}`);
  return toTemplate((await res.json()) as BackendItem);
}

/** Submit a 1–5 rating to the backend; returns the new average. */
export async function rateMarketplaceItem(id: string, rating: number): Promise<number> {
  const backend = getMarketplaceBackendUrl();
  if (!backend) throw new Error("No marketplace backend configured");
  const res = await fetch(`${backend}/items/${encodeURIComponent(id)}/rate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rating }),
  });
  if (!res.ok) throw new Error(`Rate ${res.status}`);
  return ((await res.json()) as { rating: number }).rating;
}
