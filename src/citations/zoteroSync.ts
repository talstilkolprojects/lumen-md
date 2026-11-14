/**
 * The local Zotero library into the vault as CSL-JSON (plan W2.16), so the
 * cite dialog finds it and `[@key]` resolves offline. Zotero 7's local API
 * (`/api/users/0/items/top?format=csljson`) through the desktop app's
 * native bridge (src-tauri/src/zotero_local.rs, 127.0.0.1 only; the same
 * bridge W2.15 uses for annotations). Zotero refuses web pages, so the web
 * app says to use the desktop app.
 */
export interface LocalResponse {
  status: number;
  total: number | null;
  body: string;
}
export type LocalGet = (path: string) => Promise<LocalResponse>;

export class ZoteroUnavailable extends Error {
  readonly reason: "not-running" | "disabled" | "browser" | "error";
  constructor(reason: "not-running" | "disabled" | "browser" | "error", message: string) {
    super(message);
    this.name = "ZoteroUnavailable";
    this.reason = reason;
  }
}

const PAGE = 100;

/** Every top-level item as CSL-JSON (notes and attachments left out). */
export async function zoteroCslItems(get: LocalGet): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let start = 0; ; start += PAGE) {
    const r = await get(`/api/users/0/items/top?format=csljson&limit=${PAGE}&start=${start}`);
    if (r.status === 403) throw new ZoteroUnavailable("disabled", r.body || "Local API is not enabled");
    if (r.status !== 200) throw new ZoteroUnavailable("error", `Zotero answered ${r.status}: ${r.body.slice(0, 200)}`);
    const v = JSON.parse(r.body) as unknown[] | { items?: unknown[] };
    const page = Array.isArray(v) ? v : (v.items ?? []);
    out.push(...page.filter((x) => (x as { type?: string }).type !== "note" && (x as { type?: string }).type !== "attachment"));
    if (page.length < PAGE || (r.total !== null && start + page.length >= r.total)) return out;
  }
}

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function desktopZoteroGet(): Promise<LocalGet> {
  if (!isTauri()) throw new ZoteroUnavailable("browser", "Zotero only answers apps on this computer: use the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  return async (path) => {
    try {
      return await invoke<LocalResponse>("zotero_local_get", { path });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      throw new ZoteroUnavailable(/refused|connect/i.test(msg) ? "not-running" : "error", msg);
    }
  };
}
