/**
 * Which open document an agent run works on (plan 5.11).
 *
 * A change an agent proposes for the open document has no workspace path
 * when the document is not in the workspace (an untitled or imported one),
 * so the path cannot say which document it belongs to. The editor
 * registers a provider of opaque keys that stay the same for a document
 * while it is open — across tab switches and saving it into the workspace
 * — and change when a different document is loaded (agents/reviewBridge).
 * The runtime records the active document's key when a run starts, and an
 * approval applies the run's changes to that document only.
 *
 * Kept apart from staging so the runtime reads it without loading staging.
 */

let provider: (() => string | undefined) | null = null;

/** The editor registers how to read the active document's key (null to unregister). */
export function setDocumentKeyProvider(fn: (() => string | undefined) | null): void {
  provider = fn;
}

/** The active document's key, or undefined without an editor. */
export function currentDocumentKey(): string | undefined {
  try {
    return provider?.() ?? undefined;
  } catch {
    return undefined;
  }
}
