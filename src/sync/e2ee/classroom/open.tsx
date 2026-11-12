/**
 * Mounts the classroom panel in its own root (plan W5.21), like the sync
 * panel (../ui/open.tsx), so the startup bundle carries only the command.
 */

import { createRoot, type Root } from "react-dom/client";
import { ClassroomPanel } from "./ClassroomPanel";
import { parseClassHash, type ClassLink } from "./link";

let root: Root | null = null;
let host: HTMLElement | null = null;

export function closeClassroom(): void {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
}

export function openClassroom(joining: ClassLink | null = null): void {
  closeClassroom();
  host = document.createElement("div");
  host.dataset.lumenClassroom = "";
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(<ClassroomPanel onClose={closeClassroom} joining={joining} />);
}

/**
 * A `#class=` link was opened: drop the fragment from the address (it stays
 * out of the history and of anything that later reads the URL), then offer
 * to join. A broken link opens the panel with nothing to join.
 */
export async function joinFromHash(hash: string): Promise<void> {
  history.replaceState(null, "", location.pathname + location.search);
  const link = await parseClassHash(hash).catch(() => null);
  openClassroom(link);
}
