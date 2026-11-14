/**
 * Airplane mode's helpers that hold no switch state: where in the code a
 * request came from, the same-origin test, and the frames that may have
 * opened a window (plan W6.25: moved out of airplane.ts unchanged;
 * airplane.ts re-exports codeOrigin).
 */
import { rootsOf } from "./airplaneBoot";

/**
 * The place in the code a request came from. `skip` is the number of this
 * module's own frames on top (the recording helper and the wrapper: 2), so
 * the answer does not depend on how the build names or merges chunks; any
 * later frame still in this module is skipped by name as well.
 */
export function codeOrigin(stack: string | undefined, skip = 0): string {
  const frames = (stack ?? "").split("\n").map((l) => l.trim()).filter((l) => /:\d+:\d+\)?$/.test(l));
  const rest = frames.slice(skip);
  const outside = rest.find((l) => !/privacy\/airplane|airplane[-.][\w-]*\.js/.test(l)) ?? rest[0] ?? frames[0] ?? "";
  // "at fn (https://host/assets/x-abc.js:1:234)" / "fn@https://host/assets/x.js:1:234" → "fn x-abc.js:1:234"
  const m = /^(?:at\s+)?(?:(.*?)\s*\(|(.*?)@)?(?:[a-z-]+:\/\/[^/]+)?\/?([^()]*?:\d+:\d+)\)?$/.exec(outside);
  if (!m) return outside.slice(0, 160);
  const fn = (m[1] ?? m[2] ?? "").replace(/^async\s+/, "").trim();
  const file = m[3].split("/").pop() ?? m[3];
  return `${fn ? `${fn} ` : ""}${file}`.slice(0, 160);
}

export function sameOrigin(url: string, base: string | undefined): boolean {
  try {
    return !!base && new URL(url, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/**
 * Frames that may have opened a window this page can't close (review 8,
 * RR8-451-1, -2): a frame whose sandbox allows popups, or that has none,
 * unless its window is one whose window.open is tracked (`trackOpen`); and
 * the same in same-origin frames' documents.
 */
export function popupFrames(doc: Pick<Document, "querySelectorAll">, depth = 0, seen?: Set<HTMLIFrameElement>): string[] {
  const out: string[] = [];
  for (const root of rootsOf(doc)) {
    let frames: HTMLIFrameElement[] = [];
    try {
      frames = Array.from(root.querySelectorAll("iframe"));
    } catch {
      /* why: a fake document */
    }
    for (const f of frames) {
      let inner: Document | null = null;
      let tracked = false;
      try {
        inner = f.contentDocument;
        tracked = Boolean((f.contentWindow as (Window & { __lumenOpen?: boolean }) | null)?.__lumenOpen);
      } catch {
        /* why: another origin's page: its window.open is out of reach */
      }
      const sb = f.getAttribute("sandbox");
      const may = sb === null || sb.split(/[\t\n\f\r ]+/).some((t) => t.toLowerCase() === "allow-popups");
      if (may && !tracked) {
        out.push(f.getAttribute("srcdoc") !== null ? "about:srcdoc" : f.getAttribute("src") || "about:blank");
        seen?.add(f);
      }
      if (inner && depth < 8) out.push(...popupFrames(inner, depth + 1, seen));
    }
  }
  return out;
}
