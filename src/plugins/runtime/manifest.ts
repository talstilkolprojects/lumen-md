/**
 * Plugin manifest and capabilities (plan 11.2.3).
 *
 * A plugin is a folder with `lumen-plugin.json` (this manifest), a logic
 * entry (`main`, JavaScript that runs in the QuickJS sandbox, see
 * host.worker.ts) and, optionally, a UI entry (`ui`, JavaScript that runs
 * in a sandboxed iframe with `default-src 'none'`, see uiFrame.ts).
 *
 * Every capability is DENIED unless the user granted it at install time.
 * The manifest declares what the plugin wants and why; the grant is a
 * separate, user-made set (capabilities.ts). A call the plugin makes
 * without the grant fails with a `PluginDenied` error in the sandbox, is
 * never forwarded to the app, and is counted (pluginHost.ts).
 */

/** What a plugin may ask for. `network:<origin>` is one capability per exact origin. */
export const CAPABILITIES = [
  "document:read",
  "document:write",
  "vault:read",
  "vault:write",
  "commands",
  "panel",
  "renderer",
  "settings",
  "storage",
  "clipboard:write",
  "notifications",
  // W6.46: the Bases API — read a view's rows; change note properties behind one approval per call.
  "bases:read",
  "bases:write",
] as const;

export type StaticCapability = (typeof CAPABILITIES)[number];
export type NetworkCapability = `network:${string}`;
export type Capability = StaticCapability | NetworkCapability;

export interface CapabilityRequest {
  id: Capability;
  /** Why the plugin needs it, shown to the user before the grant. */
  reason: string;
}

export interface PluginManifest {
  schema: 1;
  /** Stable id: lower-case letters, digits, dots and dashes; 3–64 chars; e.g. "org.example.word-count". */
  id: string;
  name: string;
  /** Semantic version. */
  version: string;
  description: string;
  author: string;
  /** SPDX licence identifier. */
  license: string;
  /** Relative path of the logic entry (ES module, runs in QuickJS). */
  main: string;
  /** Relative path of the UI entry (ES module, runs in the sandboxed iframe). */
  ui?: string;
  capabilities: CapabilityRequest[];
  /** Lowest Lumen version the plugin needs. */
  minLumen?: string;
  homepage?: string;
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

const ID_RE = /^[a-z0-9][a-z0-9.-]{2,63}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const PATH_RE = /^(?!\.\.?(\/|$))(?!\/)[A-Za-z0-9_./-]+\.(m?js)$/;
const MAX_CAPABILITIES = 32;

export function isNetworkCapability(cap: string): cap is NetworkCapability {
  return cap.startsWith("network:");
}

/** The origin a network capability names, or null when it is not a valid https origin (http only for localhost). */
export function networkOrigin(cap: string): string | null {
  if (!isNetworkCapability(cap)) return null;
  const raw = cap.slice("network:".length);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.origin !== raw) return null; // an origin only: no path, query, fragment, credentials
  if (u.protocol === "https:") return u.origin;
  if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return u.origin;
  return null;
}

export function isCapability(cap: string): cap is Capability {
  return (CAPABILITIES as readonly string[]).includes(cap) || networkOrigin(cap) !== null;
}

function str(obj: Record<string, unknown>, key: string, max = 200, required = true): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) {
    if (required) throw new ManifestError(`manifest: "${key}" is required`);
    return undefined;
  }
  if (typeof v !== "string" || !v.trim()) throw new ManifestError(`manifest: "${key}" must be a non-empty string`);
  if (v.length > max) throw new ManifestError(`manifest: "${key}" is longer than ${max} characters`);
  return v;
}

/** Parse and validate a manifest (JSON text or an already-parsed object). Throws ManifestError. */
export function parseManifest(input: string | unknown): PluginManifest {
  let raw: unknown = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new ManifestError("manifest: not valid JSON");
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ManifestError("manifest: must be an object");
  const o = raw as Record<string, unknown>;
  if (o.schema !== 1) throw new ManifestError('manifest: "schema" must be 1');
  const id = str(o, "id", 64)!;
  if (!ID_RE.test(id)) throw new ManifestError(`manifest: "id" ${JSON.stringify(id)} must match ${ID_RE}`);
  const version = str(o, "version", 64)!;
  if (!SEMVER_RE.test(version)) throw new ManifestError(`manifest: "version" ${JSON.stringify(version)} is not a semantic version`);
  const main = str(o, "main", 200)!;
  if (!PATH_RE.test(main)) throw new ManifestError(`manifest: "main" must be a relative .js/.mjs path inside the plugin`);
  const ui = str(o, "ui", 200, false);
  if (ui !== undefined && !PATH_RE.test(ui)) throw new ManifestError(`manifest: "ui" must be a relative .js/.mjs path inside the plugin`);
  const minLumen = str(o, "minLumen", 64, false);
  if (minLumen !== undefined && !SEMVER_RE.test(minLumen)) throw new ManifestError('manifest: "minLumen" is not a semantic version');
  const homepage = str(o, "homepage", 500, false);
  if (homepage !== undefined) {
    let u: URL | null = null;
    try {
      u = new URL(homepage);
    } catch {
      /* why: invalid */
    }
    if (!u || u.protocol !== "https:") throw new ManifestError('manifest: "homepage" must be an https URL');
  }
  const caps = o.capabilities;
  if (!Array.isArray(caps)) throw new ManifestError('manifest: "capabilities" must be an array (empty when none are needed)');
  if (caps.length > MAX_CAPABILITIES) throw new ManifestError(`manifest: more than ${MAX_CAPABILITIES} capabilities`);
  const seen = new Set<string>();
  const capabilities: CapabilityRequest[] = caps.map((c, i) => {
    if (!c || typeof c !== "object") throw new ManifestError(`manifest: capabilities[${i}] must be { id, reason }`);
    const cc = c as Record<string, unknown>;
    const cid = str(cc, "id", 300)!;
    if (!isCapability(cid)) throw new ManifestError(`manifest: capabilities[${i}].id ${JSON.stringify(cid)} is not a known capability (network capabilities name one https origin)`);
    if (seen.has(cid)) throw new ManifestError(`manifest: capability ${cid} is listed twice`);
    seen.add(cid);
    const reason = str(cc, "reason", 300)!;
    return { id: cid, reason };
  });
  return {
    schema: 1,
    id,
    name: str(o, "name", 80)!,
    version,
    description: str(o, "description", 500)!,
    author: str(o, "author", 120)!,
    license: str(o, "license", 60)!,
    main,
    ...(ui !== undefined ? { ui } : {}),
    capabilities,
    ...(minLumen !== undefined ? { minLumen } : {}),
    ...(homepage !== undefined ? { homepage } : {}),
  };
}

/** `a >= b` for semantic versions (prerelease tags ignored). */
export function semverAtLeast(a: string, b: string): boolean {
  const pa = a.split(/[-+]/)[0].split(".").map(Number);
  const pb = b.split(/[-+]/)[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return true;
}
