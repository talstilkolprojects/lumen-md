/** Types of the Lumen plugin test kit (testkit.mjs), for editors and TypeScript tests. */
export declare const METHODS: Readonly<Record<string, string>>;

export declare class PluginDenied extends Error {
  readonly capability: string;
}

export interface UiTree {
  type: string;
  [k: string]: unknown;
}

export interface LoadOptions {
  dir?: string;
  manifest?: { main?: string; capabilities?: { id: string; reason?: string }[]; [k: string]: unknown };
  code?: string;
  grants?: "all" | string[];
  document?: { text?: string; fileName?: string; selection?: [number, number] };
  vault?: Record<string, string>;
  settings?: Record<string, unknown>;
  storage?: Record<string, unknown>;
  fetch?: (url: string, init?: unknown) => unknown;
}

export interface LoadedPlugin {
  manifest: Record<string, unknown>;
  grants: Set<string>;
  document: { text: string; fileName: string; selection: [number, number] };
  vault: Map<string, string>;
  readonly settings: Record<string, unknown>;
  storage: Map<string, unknown>;
  commands: Map<string, { id: string; label: string; hint?: string }>;
  renderers: Set<string>;
  panel: { open: boolean; title: string | null; tree: UiTree | null };
  rendered: UiTree[];
  notifications: { text: string; kind: "info" | "success" | "error" }[];
  readonly clipboard: string | null;
  logs: { level: "log" | "warn" | "error"; text: string }[];
  calls: { method: string; args: unknown[]; outcome: "ok" | "denied" }[];
  denied: Map<string, number>;
  run(id: string, payload?: unknown): Promise<void>;
  emit(name: string, payload?: unknown): Promise<void>;
  render(lang: string, source: string): Promise<UiTree>;
  select(from: number, to?: number): void;
}

export declare function loadPlugin(opts?: LoadOptions): Promise<LoadedPlugin>;
