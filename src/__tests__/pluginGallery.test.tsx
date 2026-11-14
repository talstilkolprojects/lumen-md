/**
 * W10.B1 + W10.B2: the gallery never fakes a remote install and never
 * shows "verified" without a signature that checks out.
 *
 * Nothing in the install path is mocked: the real pluginSystem, the real
 * registryTrust and the real WebCrypto signature check run. Only the
 * network edge (`fetch`) is replaced, and it serves the registry file
 * that ships in public/plugins/registry.json, read from disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { PluginGallery } from "../ui/PluginGallery";
import { getRegisteredPlugins, unregisterPlugin } from "../plugins/pluginSystem";
import { checkRegistryEntry, isRemoteInstallable } from "../plugins/registryTrust";
import { fingerprintOf, trustKey, untrustKey } from "../plugins/signing";

const SHIPPED = JSON.parse(readFileSync("public/plugins/registry.json", "utf8")) as {
  plugins: Array<{ id: string; name: string; verified?: boolean }>;
};

let requested: string[] = [];

function serveRegistry(registry: unknown) {
  requested = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requested.push(url);
    if (url.endsWith("/plugins/registry.json")) {
      return new Response(JSON.stringify(registry), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  });
}

function cardFor(container: HTMLElement, name: string): HTMLElement {
  const cards = Array.from(container.querySelectorAll<HTMLElement>("[data-testid='plugin-card']"));
  const card = cards.find((c) => c.textContent?.includes(name));
  if (!card) throw new Error(`no card for ${name}`);
  return card;
}

beforeEach(() => {
  for (const p of getRegisteredPlugins()) unregisterPlugin(p.id);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PluginGallery remote install (W10.B1)", () => {
  it("the shipped registry has entries, so the checks below are not vacuous", () => {
    expect(SHIPPED.plugins.length).toBeGreaterThanOrEqual(4);
  });

  it("an unsigned remote entry offers 'Not available yet', not Install", async () => {
    serveRegistry(SHIPPED);
    const { container } = render(<PluginGallery open onClose={() => {}} />);
    const first = SHIPPED.plugins[0];
    await waitFor(() => expect(container.textContent).toContain(first.name));
    for (const entry of SHIPPED.plugins) {
      const card = cardFor(container, entry.name);
      const unavailable = card.querySelector<HTMLButtonElement>("[data-testid='plugin-unavailable']");
      expect(unavailable, entry.id).not.toBeNull();
      expect(unavailable!.disabled).toBe(true);
      expect(card.textContent).not.toMatch(/\bInstall\b/);
      expect(card.querySelector("[data-testid='plugin-unavailable-hint']")).not.toBeNull();
    }
  });

  it("clicking a remote entry adds no plugin and shows no success", async () => {
    serveRegistry(SHIPPED);
    const { container } = render(<PluginGallery open onClose={() => {}} />);
    const first = SHIPPED.plugins[0];
    await waitFor(() => expect(container.textContent).toContain(first.name));
    const card = cardFor(container, first.name);
    for (const button of Array.from(card.querySelectorAll("button"))) fireEvent.click(button);
    await new Promise((r) => setTimeout(r, 600)); // longer than the old 400 ms fake
    expect(getRegisteredPlugins().map((p) => p.id)).not.toContain(first.id);
    expect(container.textContent ?? "").not.toMatch(/Loaded .* from remote module|Uninstall/);
    // No remote bundle was downloaded for an unsigned registry. (The
    // sandboxed-examples section loads its own JSON index; that is not a bundle.)
    const bundleUrls = (SHIPPED.plugins as Array<{ url?: string }>).map((p) => p.url).filter(Boolean) as string[];
    expect(bundleUrls.length).toBeGreaterThan(0);
    expect(requested.filter((u) => bundleUrls.some((b) => u.endsWith(b)) || /\.m?js$/.test(u))).toEqual([]);
  });

  it("the gallery has no remote install path at all yet", () => {
    for (const entry of SHIPPED.plugins) expect(isRemoteInstallable(entry)).toBe(false);
  });

  it("the source has no simulated install left", () => {
    const src = readFileSync("src/ui/PluginGallery.tsx", "utf8");
    expect(src).not.toMatch(/simulate/i);
    expect(src).not.toMatch(/setTimeout\(resolve,\s*400\)/);
    expect(src).not.toContain("loadedFromRemoteModule");
  });

  it("built-in plugins still install for real", async () => {
    serveRegistry({ plugins: [] });
    const { container } = render(<PluginGallery open onClose={() => {}} />);
    const card = cardFor(container, "Reading Time");
    const install = Array.from(card.querySelectorAll("button")).find((b) => /Install/.test(b.textContent ?? ""));
    expect(install).toBeDefined();
    fireEvent.click(install!);
    await waitFor(() => expect(getRegisteredPlugins().map((p) => p.id)).toContain("community.reading-time"));
  });
});

describe("PluginGallery verified badge (W10.B2)", () => {
  it("no card from the shipped registry, and no built-in, shows the verified badge", async () => {
    serveRegistry(SHIPPED);
    const { container } = render(<PluginGallery open onClose={() => {}} />);
    await waitFor(() => expect(container.textContent).toContain(SHIPPED.plugins[0].name));
    expect(container.querySelectorAll("[data-testid='plugin-verified-badge']").length).toBe(0);
    for (const entry of SHIPPED.plugins) {
      expect(cardFor(container, entry.name).querySelector("[data-testid='plugin-trust']")?.textContent).toBe("Not verified");
    }
  });

  it("an entry that declares verified: true without a signature gets no badge", async () => {
    serveRegistry({ plugins: [{ id: "self-declared", name: "Self Declared", author: "x", description: "d", version: "1.0.0", verified: true, url: "/plugins/x.js" }] });
    const { container } = render(<PluginGallery open onClose={() => {}} />);
    await waitFor(() => expect(container.textContent).toContain("Self Declared"));
    const card = cardFor(container, "Self Declared");
    expect(card.querySelector("[data-testid='plugin-verified-badge']")).toBeNull();
    expect(card.querySelector("[data-testid='plugin-trust']")?.textContent).toBe("Not verified");
  });
});

describe("registryTrust.checkRegistryEntry (real Ed25519)", () => {
  async function signed(bundle: Uint8Array) {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
    const spkiB64 = btoa(String.fromCharCode(...spki));
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, new Uint8Array(bundle)));
    return { spkiB64, fingerprint: await fingerprintOf(spkiB64), signature: btoa(String.fromCharCode(...sig)) };
  }

  it("unsigned → unverified, and the bundle is not fetched", async () => {
    const fetchBytes = vi.fn(async () => new Uint8Array());
    expect(await checkRegistryEntry({ id: "a", url: "/a.js", verified: true }, fetchBytes)).toBe("unverified");
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it("a valid signature from a key that is not pinned → unverified", async () => {
    const bundle = new TextEncoder().encode("export default 1;");
    const s = await signed(bundle);
    const r = await checkRegistryEntry({ id: "a", url: "/a.js", signature: s.signature, signedBy: s.fingerprint }, async () => bundle);
    expect(r).toBe("unverified");
  });

  it("pinned key: verified; one changed byte: unverified", async () => {
    const bundle = new TextEncoder().encode("export default 1;");
    const s = await signed(bundle);
    await trustKey(s.fingerprint, s.spkiB64);
    try {
      const entry = { id: "a", url: "/a.js", signature: s.signature, signedBy: s.fingerprint };
      expect(await checkRegistryEntry(entry, async () => bundle)).toBe("verified");
      const tampered = bundle.slice();
      tampered[0] ^= 1;
      expect(await checkRegistryEntry(entry, async () => tampered)).toBe("unverified");
      expect(await checkRegistryEntry(entry, async () => { throw new Error("offline"); })).toBe("unverified");
    } finally {
      await untrustKey(s.fingerprint);
    }
  });
});
