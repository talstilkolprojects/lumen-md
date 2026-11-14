import { createContext } from "react";

/**
 * From this length on (plan 8.4) the preview renders block by block
 * (./incrementalPreview.ts), the outline re-parses only changed blocks
 * (./incrementalToc.ts) and the status bar counts words once typing
 * pauses. Shorter documents keep the one-pass paths, which are fast there.
 */
export const LARGE_DOC_CHARS = 50_000;

/**
 * Identity of the document whose markdown the surrounding preview tree was
 * rendered from. The preview renders asynchronously, so while switching tabs
 * it briefly still shows the previous document's tree; blocks that keep
 * per-document state (live-js shared scopes) must use this — not the
 * store's *current* document — or the old blocks would run in the new
 * document's scope. null outside a document preview.
 */
export const PreviewDocKeyContext = createContext<string | null>(null);

const handleIds = new WeakMap<object, string>();
let nextHandleId = 0;

/**
 * Stable per-document key for per-document runtime state. Workspace files
 * are identified by their workspace path; files opened from disk by their
 * FileSystemFileHandle (two `readme.md` from different folders share a
 * name but not a handle); anything else by name plus its load id, so two
 * loads of same-named handle-less files never share state.
 */
export function docIdentity(doc: {
  workspaceName?: string | null;
  name?: string | null;
  handle?: object | null;
  loadId?: number;
}): string | null {
  if (doc.workspaceName) return `ws:${doc.workspaceName}`;
  if (doc.handle) {
    let id = handleIds.get(doc.handle);
    if (!id) {
      id = `fh:${++nextHandleId}`;
      handleIds.set(doc.handle, id);
    }
    return `${id}:${doc.name ?? ""}`;
  }
  if (!doc.name) return null;
  return doc.loadId === undefined ? `name:${doc.name}` : `name:${doc.name}#${doc.loadId}`;
}
