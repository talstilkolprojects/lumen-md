/**
 * Tests for the WorkOS SSO provider shell (ε.1 / F4).
 *
 * The actual SAML dance lives in the edge worker (created when the
 * WorkOS account is provisioned); this client just calls JSON
 * endpoints. We mock fetch + the env reader so the tests are
 * hermetic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  signInWithSso,
  loadSsoSession,
  signOutSso,
  workosProvider,
  isWorkosEnabled,
  getSsoAccessToken,
  __setWorkOSConfigForTesting,
} from "../auth/workosProvider";

beforeEach(() => {
  vi.unstubAllGlobals();
  __setWorkOSConfigForTesting(null);
});

afterEach(() => {
  __setWorkOSConfigForTesting(null);
});

describe("isWorkosEnabled", () => {
  it("returns false when no endpoint is configured", () => {
    expect(isWorkosEnabled()).toBe(false);
  });

  it("returns true once the test config is set", () => {
    __setWorkOSConfigForTesting({ endpoint: "https://auth.example.com" });
    expect(isWorkosEnabled()).toBe(true);
  });
});

describe("signInWithSso", () => {
  it("throws when no endpoint is configured", async () => {
    await expect(signInWithSso("acme.com")).rejects.toThrow(/not configured/);
  });

  it("requires a non-empty domain", async () => {
    __setWorkOSConfigForTesting({ endpoint: "https://auth.example.com" });
    await expect(signInWithSso("")).rejects.toThrow(/domain required/i);
  });

  it("returns the redirect URL on success", async () => {
    __setWorkOSConfigForTesting({ endpoint: "https://auth.example.com" });
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ redirect: "https://idp.acme.com/saml/sso" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const url = await signInWithSso("acme.com");
    expect(url).toBe("https://idp.acme.com/saml/sso");
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://auth.example.com/api/sso/authorize?domain=acme.com",
    );
  });

  it("throws on a 4xx response", async () => {
    __setWorkOSConfigForTesting({ endpoint: "https://auth.example.com" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 404 })),
    );
    await expect(signInWithSso("acme.com")).rejects.toThrow(/404/);
  });
});

describe("loadSsoSession", () => {
  it("returns null when no endpoint is configured", async () => {
    expect(await loadSsoSession()).toBeNull();
  });

  it("returns null on 401 (anonymous)", async () => {
    __setWorkOSConfigForTesting({ endpoint: "https://auth.example.com" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 401 })),
    );
    expect(await loadSsoSession()).toBeNull();
  });

  it("returns the User from the worker JSON", async () => {
    __setWorkOSConfigForTesting({ endpoint: "https://auth.example.com" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            user: { id: "u1", email: "x@acme.com", provider: "workos" },
          }),
          { status: 200 },
        ),
      ),
    );
    const user = await loadSsoSession();
    expect(user?.id).toBe("u1");
    expect(user?.provider).toBe("workos");
  });

  it("swallows network errors as anonymous (returns null)", async () => {
    __setWorkOSConfigForTesting({ endpoint: "https://auth.example.com" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await loadSsoSession()).toBeNull();
  });
});

describe("signOutSso + workosProvider record", () => {
  it("signOutSso is a safe no-op when no endpoint is configured", async () => {
    await expect(signOutSso()).resolves.toBeUndefined();
  });

  it("workosProvider.name is the stable telemetry tag", () => {
    expect(workosProvider.name).toBe("workos");
  });

  it("workosProvider.loadSession + signOut are wired through to the helpers", async () => {
    __setWorkOSConfigForTesting({ endpoint: "https://auth.example.com" });
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    await workosProvider.loadSession();
    await workosProvider.signOut();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("signOutSso rejects when the worker doesn't clear the session (HTTP error or network)", async () => {
    __setWorkOSConfigForTesting({ endpoint: "https://auth.example.com" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
    await expect(signOutSso()).rejects.toThrow(/sign-out failed/);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(signOutSso()).rejects.toThrow();
  });
});

describe("getAccessToken (billing bearer token)", () => {
  it("returns null when no endpoint is configured", async () => {
    expect(await workosProvider.getAccessToken!()).toBeNull();
  });

  it("fetches /api/sso/token with credentials and caches until near expiry", async () => {
    __setWorkOSConfigForTesting({ endpoint: "https://auth.example.com" });
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ token: "tok-1", expiresAt: 1_000_300 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    expect(await getSsoAccessToken(1_000_000)).toBe("tok-1");
    expect(await getSsoAccessToken(1_000_200)).toBe("tok-1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://auth.example.com/api/sso/token");
    expect(init.credentials).toBe("include");
    // Within 30 s of expiry → refetch.
    await getSsoAccessToken(1_000_280);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns null (anonymous) when signed out or the worker isn't configured for billing", async () => {
    __setWorkOSConfigForTesting({ endpoint: "https://auth.example.com" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    expect(await getSsoAccessToken()).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 501 })));
    expect(await getSsoAccessToken()).toBeNull();
  });
});

describe("isCrossSiteEndpoint (third-party cookie check)", () => {
  it("treats sibling subdomains and same host as same-site", async () => {
    const { isCrossSiteEndpoint } = await import("../auth/workosProvider");
    expect(isCrossSiteEndpoint("https://auth.example.org", "app.example.org")).toBe(false);
    expect(isCrossSiteEndpoint("https://example.org/api", "example.org")).toBe(false);
    expect(isCrossSiteEndpoint("http://localhost:8787", "localhost")).toBe(false);
  });
  it("flags workers.dev and other registrable domains as cross-site", async () => {
    const { isCrossSiteEndpoint } = await import("../auth/workosProvider");
    expect(isCrossSiteEndpoint("https://lumen-auth.acme.workers.dev", "app.example.org")).toBe(true);
    // workers.dev is a public suffix: the account subdomain is the site.
    expect(isCrossSiteEndpoint("https://a.acme.workers.dev", "b.acme.workers.dev")).toBe(false);
    expect(isCrossSiteEndpoint("https://a.acme.workers.dev", "b.other.workers.dev")).toBe(true);
    expect(isCrossSiteEndpoint("https://auth.other.com", "example.org")).toBe(true);
  });
});
