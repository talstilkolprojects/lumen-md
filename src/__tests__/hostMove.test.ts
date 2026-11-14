/**
 * Plan W6.9: the old address after a host move (src/pwa/hostMove.ts). A
 * browser with notes here keeps the app and gets a banner to take them along;
 * the target keeps the path, query and hash.
 */
import { afterEach, describe, expect, it } from "vitest";
import { moveTarget } from "../pwa/moveTarget";
import { showMoveBanner } from "../pwa/hostMove";

describe("moveTarget", () => {
  const here = { href: "https://lumen-md.vercel.app/notes/a%20b?x=1#h2" };
  it("keeps the path, query and hash on the new origin", () => {
    expect(moveTarget("https://lumen-md.pages.dev", here)).toBe("https://lumen-md.pages.dev/notes/a%20b?x=1#h2");
    expect(moveTarget("https://lumen-md.pages.dev/ignored/path", here)).toBe("https://lumen-md.pages.dev/notes/a%20b?x=1#h2");
  });
  it("does nothing without a different http(s) origin", () => {
    expect(moveTarget(undefined, here)).toBeNull();
    expect(moveTarget("", here)).toBeNull();
    expect(moveTarget("not a url", here)).toBeNull();
    expect(moveTarget("javascript:alert(1)", here)).toBeNull();
    expect(moveTarget("https://lumen-md.vercel.app/other", here)).toBeNull();
  });
});

describe("the move banner", () => {
  afterEach(() => {
    document.querySelectorAll(".lumen-host-move").forEach((n) => n.remove());
    sessionStorage.clear();
  });

  it("names the new host, links to the same path there, and offers the download", () => {
    const bar = showMoveBanner("https://lumen-md.pages.dev");
    expect(bar).not.toBeNull();
    expect(document.body.firstElementChild).toBe(bar);
    expect(bar!.getAttribute("role")).toBe("region");
    expect(bar!.textContent).toContain("lumen-md.pages.dev");
    const link = bar!.querySelector("a")!;
    expect(new URL(link.href).origin).toBe("https://lumen-md.pages.dev");
    expect(new URL(link.href).pathname).toBe(location.pathname);
    expect([...bar!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Download my notes (.zip)", "Later"]);
  });

  it("Later hides it for this session", () => {
    const bar = showMoveBanner("https://lumen-md.pages.dev")!;
    [...bar.querySelectorAll("button")].find((b) => b.textContent === "Later")!.click();
    expect(document.querySelector(".lumen-host-move")).toBeNull();
    expect(showMoveBanner("https://lumen-md.pages.dev")).toBeNull();
  });

  it("is not shown when the target is this origin", () => {
    expect(showMoveBanner(location.origin)).toBeNull();
  });
});
