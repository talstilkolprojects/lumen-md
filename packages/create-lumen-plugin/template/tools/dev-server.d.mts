/** Types of the Lumen plugin dev server (dev-server.mjs). */
export interface DevServer {
  url: string;
  clients: Set<unknown>;
  close(): Promise<void>;
}
export declare function startDevServer(opts?: { dir?: string; port?: number; debounceMs?: number; log?: (msg: string) => void }): Promise<DevServer>;
