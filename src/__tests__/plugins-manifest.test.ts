/** Plan 11.2 — manifest validation, grants and the UI tree schema. */
import { describe, it, expect } from "vitest";
import { parseManifest, networkOrigin, semverAtLeast, CAPABILITIES } from "../plugins/runtime/manifest";
import { grantsFrom, intersectWithManifest, networkGranted } from "../plugins/runtime/capabilities";
import { validateUiTree, UI_LIMITS } from "../plugins/runtime/uiTree";

const base = { schema: 1, id: "org.example.hello", name: "Hello", version: "1.2.3", description: "Says hello", author: "Example", license: "MIT", main: "main.js", capabilities: [] };

describe("parseManifest", () => {
  it("accepts a minimal manifest and keeps only known fields", () => {
    const m = parseManifest({ ...base, extra: 1 });
    expect(m).toEqual(base);
    expect("extra" in m).toBe(false);
  });
  it.each([
    [{ schema: 2 }, /schema/],
    [{ id: "Bad Id" }, /"id"/],
    [{ id: "ab" }, /"id"/],
    [{ version: "1.2" }, /semantic version/],
    [{ main: "../x.js" }, /"main"/],
    [{ main: "/abs.js" }, /"main"/],
    [{ main: "main.ts" }, /"main"/],
    [{ ui: "https://cdn.example/ui.js" }, /"ui"/],
    [{ homepage: "http://insecure.example" }, /homepage/],
    [{ capabilities: "all" }, /capabilities/],
    [{ capabilities: [{ id: "root", reason: "x" }] }, /not a known capability/],
    [{ capabilities: [{ id: "network:https://a.example/path", reason: "x" }] }, /not a known capability/],
    [{ capabilities: [{ id: "network:http://a.example", reason: "x" }] }, /not a known capability/],
    [{ capabilities: [{ id: "commands" }] }, /reason/],
    [{ capabilities: [{ id: "commands", reason: "a" }, { id: "commands", reason: "b" }] }, /twice/],
    [{ name: "" }, /"name"/],
  ])("rejects %j", (patch, re) => {
    expect(() => parseManifest({ ...base, ...patch })).toThrow(re);
  });
  it("accepts every static capability and an https origin; http only for localhost", () => {
    const m = parseManifest({ ...base, capabilities: [...CAPABILITIES.map((id) => ({ id, reason: "r" })), { id: "network:https://api.example.com", reason: "r" }, { id: "network:http://localhost:8787", reason: "r" }] });
    expect(m.capabilities).toHaveLength(CAPABILITIES.length + 2);
    expect(networkOrigin("network:https://api.example.com")).toBe("https://api.example.com");
    expect(networkOrigin("network:https://user:pw@api.example.com")).toBeNull();
    expect(networkOrigin("network:https://api.example.com/")).toBeNull();
  });
  it("parses JSON text", () => {
    expect(parseManifest(JSON.stringify(base)).id).toBe("org.example.hello");
    expect(() => parseManifest("{")).toThrow(/JSON/);
  });
  it("compares versions", () => {
    expect(semverAtLeast("1.2.3", "1.2.3")).toBe(true);
    expect(semverAtLeast("1.10.0", "1.9.9")).toBe(true);
    expect(semverAtLeast("0.9.0", "1.0.0")).toBe(false);
  });
});

describe("grants", () => {
  it("drops unknown entries and normalises network origins", () => {
    const g = grantsFrom(["commands", "network:https://api.example.com", "network:https://bad.example/path", "superuser"]);
    expect([...g].sort()).toEqual(["commands", "network:https://api.example.com", "superuser"].sort());
    expect(networkGranted(g, "https://api.example.com/x?y")).toBe(true);
    expect(networkGranted(g, "https://bad.example/path")).toBe(false);
    expect(networkGranted(g, "not a url")).toBe(false);
  });
  it("are limited to what the manifest declared", () => {
    const m = parseManifest({ ...base, capabilities: [{ id: "commands", reason: "r" }] });
    expect([...intersectWithManifest(grantsFrom(["commands", "vault:write"]), m)]).toEqual(["commands"]);
  });
});

describe("validateUiTree", () => {
  it("accepts the known kinds and strips nothing it knows", () => {
    const tree = {
      type: "box",
      direction: "column",
      gap: 8,
      children: [
        { type: "heading", level: 2, text: "כותרת" },
        { type: "paragraph", children: [{ type: "text", text: "hello" }, { type: "noteLink", target: "Daily/2026-10-24", label: "today" }] },
        { type: "list", ordered: true, items: [[{ type: "text", text: "a" }], [{ type: "code", text: "x", lang: "js" }]] },
        { type: "button", id: "save", label: "Save", primary: true },
        { type: "input", id: "name", placeholder: "Name" },
        { type: "checkbox", id: "on", label: "On", checked: true },
        { type: "select", id: "mode", value: "a", options: [{ value: "a", label: "A" }] },
        { type: "divider" },
      ],
    };
    expect(validateUiTree(tree)).toEqual(tree);
  });
  it.each([
    [{ type: "img", src: "https://evil.example/p.png" }, /unknown element kind/],
    [{ type: "iframe", src: "https://evil.example/" }, /unknown element kind/],
    [{ type: "form", action: "https://evil.example/" }, /unknown element kind/],
    [{ type: "link", href: "https://evil.example/" }, /unknown element kind/],
    [{ type: "a", href: "https://evil.example/" }, /unknown element kind/],
    [{ type: "style", text: "x" }, /unknown element kind/],
    [{ type: "script", text: "x" }, /unknown element kind/],
    [{ type: "html", html: "<b>x</b>" }, /unknown element kind/],
    [{ type: "text", text: "x", style: "background:url(https://evil.example/)" }, /unknown field/],
    [{ type: "button", id: "x", label: "y", onclick: "fetch()" }, /unknown field/],
    [{ type: "noteLink", target: "https://evil.example/" }, /not a URL/],
    [{ type: "noteLink", target: "//evil.example/" }, /not a URL/],
    [{ type: "noteLink", target: "javascript:alert(1)" }, /not a URL/],
    [{ type: "noteLink", target: "../../secret" }, /not a URL/],
    [{ type: "button", id: "has space", label: "x" }, /id/],
    [{ type: "heading", level: 7, text: "x" }, /level/],
    ["text", /must be an object/],
  ])("refuses %j", (tree, re) => {
    expect(() => validateUiTree(tree)).toThrow(re);
  });
  it("enforces the size limits", () => {
    const wide = { type: "box", children: new Array(UI_LIMITS.maxNodes).fill({ type: "divider" }) };
    expect(() => validateUiTree(wide)).toThrow(/more than/);
    let deep: unknown = { type: "divider" };
    for (let i = 0; i < UI_LIMITS.maxDepth + 1; i++) deep = { type: "box", children: [deep] };
    expect(() => validateUiTree(deep)).toThrow(/deeper/);
    expect(() => validateUiTree({ type: "text", text: "x".repeat(UI_LIMITS.maxText + 1) })).toThrow(/longer/);
  });
});
