/**
 * Make a modal overlay modal for real (review #272, step 2.21): everything
 * outside `root` is marked `inert` — no focus, no clicks, out of the
 * accessibility tree — so Tab can't reach the editor underneath and keys
 * can't edit a note nobody can see. The siblings of `root` and of each of
 * its ancestors up to `<body>` are marked; `root`'s own ancestors stay live.
 *
 * Elements already inert are left alone (and stay inert after), and an
 * element marked `data-modal-exempt` (the toast region: a save error must
 * still be announced) is skipped. The returned function undoes exactly what
 * was done. `isInsideInerted` tells whether a node is in one of the marked
 * subtrees, for a focus guard where `inert` isn't supported.
 */

export interface InertHandle {
  release(): void;
  isInsideInerted(node: Node): boolean;
}

const SKIP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "LINK", "META"]);

export function inertOutside(root: HTMLElement): InertHandle {
  const marked: Element[] = [];
  let node: Element = root;
  while (node.parentElement && node !== document.body && node !== document.documentElement) {
    const parent: HTMLElement = node.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node || SKIP.has(sibling.tagName)) continue;
      if (sibling.hasAttribute("inert") || sibling.hasAttribute("data-modal-exempt")) continue;
      sibling.setAttribute("inert", "");
      marked.push(sibling);
    }
    node = parent;
  }
  return {
    release() {
      for (const el of marked) el.removeAttribute("inert");
      marked.length = 0;
    },
    isInsideInerted(n: Node) {
      return marked.some((el) => el.contains(n));
    },
  };
}

/**
 * A modal overlay's focus (review #272, step 2.21): everything outside
 * `root` inert, focus moved into `root`, focus that still lands underneath
 * (where `inert` isn't supported) brought back, and on release the focus
 * returned to where it was. Returns the release.
 */
export function modalFocus(root: HTMLElement): () => void {
  const before = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  const inert = inertOutside(root);
  root.focus({ preventScroll: true });
  const onFocusIn = (e: FocusEvent) => {
    if (e.target instanceof Node && inert.isInsideInerted(e.target)) root.focus({ preventScroll: true });
  };
  document.addEventListener("focusin", onFocusIn);
  return () => {
    document.removeEventListener("focusin", onFocusIn);
    inert.release();
    if (before?.isConnected) before.focus({ preventScroll: true });
  };
}
