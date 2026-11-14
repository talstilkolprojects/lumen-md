/**
 * Grants: the capabilities the user allowed a plugin (plan 11.2.3). Default
 * deny — an empty grant set refuses everything. Network grants name exact
 * origins; a request to any other origin, or to a path the origin grant
 * does not cover (there is none: origins only), is refused.
 */
import { isNetworkCapability, networkOrigin, type Capability, type PluginManifest } from "./manifest";

export type Grants = ReadonlySet<Capability>;

export const NO_GRANTS: Grants = new Set();

/** Grants from a stored list; unknown or malformed entries are dropped (never widened). */
export function grantsFrom(list: readonly string[] | undefined): Grants {
  const out = new Set<Capability>();
  for (const c of list ?? []) {
    if (isNetworkCapability(c)) {
      const origin = networkOrigin(c);
      if (origin) out.add(`network:${origin}`);
    } else if (typeof c === "string") out.add(c as Capability);
  }
  return out;
}

/** Grants limited to what the manifest asked for: a grant for something not declared is meaningless. */
export function intersectWithManifest(grants: Grants, manifest: PluginManifest): Grants {
  const asked = new Set(manifest.capabilities.map((c) => c.id));
  return new Set([...grants].filter((g) => asked.has(g)));
}

export function isGranted(grants: Grants, cap: Capability): boolean {
  return grants.has(cap);
}

/** Is a network request to `url` covered by a grant? Exact origin, https (http only for localhost). */
export function networkGranted(grants: Grants, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  return grants.has(`network:${u.origin}`) && networkOrigin(`network:${u.origin}`) === u.origin;
}

/** Thrown inside the sandbox (and reported by the host) when a call lacks its capability. */
export class PluginDenied extends Error {
  constructor(
    readonly pluginId: string,
    readonly capability: Capability | string,
    detail = "",
  ) {
    super(`plugin ${pluginId}: capability ${capability} was not granted${detail ? ` (${detail})` : ""}`);
    this.name = "PluginDenied";
  }
}

/** The capability each host API method needs. Methods not listed here do not exist for plugins. */
export const METHOD_CAPABILITY: Readonly<Record<string, Capability | "network">> = {
  "document.getText": "document:read",
  "document.getFileName": "document:read",
  "document.getSelection": "document:read",
  "document.setText": "document:write",
  "document.insertText": "document:write",
  "document.replaceSelection": "document:write",
  "vault.list": "vault:read",
  "vault.read": "vault:read",
  "vault.write": "vault:write",
  "commands.register": "commands",
  "commands.unregister": "commands",
  "panel.open": "panel",
  "panel.close": "panel",
  "panel.render": "panel",
  "renderer.register": "renderer",
  "renderer.result": "renderer",
  "settings.get": "settings",
  "settings.set": "settings",
  "storage.get": "storage",
  "storage.set": "storage",
  "storage.delete": "storage",
  "clipboard.writeText": "clipboard:write",
  "notifications.show": "notifications",
  "network.fetch": "network",
};
