/**
 * "A command ran" (plan W1.29), fired by the command palette and by
 * `lumen-run-command`. Tiny on purpose: the palette imports it at startup,
 * the session recorder (lazy) listens.
 */
export const COMMAND_RAN = "lumen-command-ran";

export function announceCommand(id: string): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(COMMAND_RAN, { detail: { id } }));
}
