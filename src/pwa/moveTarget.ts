/**
 * Plan W6.9: where the old address sends a browser after a host move
 * (src/pwa/hostMove.ts): the same path, query and hash on the new origin.
 * Null when `movedTo` is not a different http(s) origin.
 */
export function moveTarget(movedTo: string | undefined, here: { href: string }): string | null {
  if (!movedTo) return null;
  let to: URL;
  let from: URL;
  try {
    to = new URL(movedTo);
    from = new URL(here.href);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(to.protocol) || to.origin === from.origin) return null;
  return new URL(from.pathname + from.search + from.hash, to.origin).href;
}
