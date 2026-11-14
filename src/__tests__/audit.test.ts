/**
 * Tests for the audit-log client (ε.2). Verifies:
 *   - When `VITE_AUDIT_ENDPOINT` isn't set, recordAudit() is a no-op.
 *   - When set, it issues a POST with the correct shape + bearer token.
 *   - listAudit serialises query params and parses the response.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// NOTE: do not statically import "../lib/audit" — every test below uses
// vi.resetModules() + dynamic import so the module re-reads `import.meta.env`
// after `vi.stubEnv()`.

// Module-scope state — must be reset between tests; we re-import via
// dynamic-import to get a clean copy each time.
beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("recordAudit", () => {
  it("is a no-op when VITE_AUDIT_ENDPOINT is unset", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const mod = await import("../lib/audit");
    mod.recordAudit("user-1", "doc.publish");
    // fire-and-forget: no synchronous fetch call expected.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts when the endpoint env var is set", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const mod = await import("../lib/audit");
    // Vite inlines `import.meta.env.VITE_*` at transform time, so
    // `vi.stubEnv` can't reach this module's static read. Use the
    // explicit test hook instead.
    mod.__setAuditConfigForTesting({
      endpoint: "https://audit.example.com",
      bearer: "secret-token",
    });
    mod.recordAudit("user-1", "doc.publish", {
      orgId: "org-7",
      payload: { slug: "hello" },
    });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://audit.example.com/audit");
    const initWithHeaders = init as RequestInit;
    expect(initWithHeaders.method).toBe("POST");
    expect((initWithHeaders.headers as Record<string, string>).Authorization).toBe(
      "Bearer secret-token",
    );
    const body = JSON.parse(initWithHeaders.body as string);
    expect(body).toMatchObject({
      user_id: "user-1",
      org_id: "org-7",
      action: "doc.publish",
    });
    expect(body.payload_json).toBe(JSON.stringify({ slug: "hello" }));
    expect(body.ts).toBeGreaterThan(0);
  });

  it("files events under the signed-in user's audit scope when no orgId is passed", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const mod = await import("../lib/audit");
    const { useAuth } = await import("../auth/useAuth");
    mod.__setAuditConfigForTesting({ endpoint: "https://audit.example.com", bearer: "tok" });
    const bodyOf = (i: number) => JSON.parse((fetchSpy.mock.calls[i][1] as RequestInit).body as string);

    // SSO org member → the organization (what the org audit log queries).
    useAuth.setState({ user: { id: "user_01", provider: "workos", orgId: "org_acme" } });
    mod.recordAudit("user_01", "doc.publish");
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(bodyOf(0).org_id).toBe("org_acme");

    // Personal user → their own id (what their audit log queries).
    useAuth.setState({ user: { id: "sb-1", provider: "supabase" } });
    mod.recordAudit("sb-1", "sync.cloud");
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(bodyOf(1).org_id).toBe("sb-1");

    // An explicit orgId (including null) still wins.
    mod.recordAudit("sb-1", "x", { orgId: null });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));
    expect(bodyOf(2).org_id).toBeNull();
  });

  it("sends the signed-in user's own token, and nothing when signed out", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const mod = await import("../lib/audit");
    const { useAuth } = await import("../auth/useAuth");
    mod.__setAuditConfigForTesting({ endpoint: "https://audit.example.com" });
    const provider = useAuth.getState().provider;

    useAuth.setState({ provider: { ...provider, getAccessToken: async () => "user-jwt" } });
    mod.recordAudit("u1", "doc.publish");
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect((fetchSpy.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer user-jwt" });

    useAuth.setState({ provider: { ...provider, getAccessToken: async () => null } });
    mod.recordAudit("u1", "doc.publish");
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expect(mod.listAudit({ orgId: "u1" })).rejects.toThrow(/Sign in/);
  });
});

describe("listAudit", () => {
  it("returns [] when the endpoint isn't configured", async () => {
    vi.resetModules();
    const mod = await import("../lib/audit");
    const rows = await mod.listAudit({ orgId: "org-1" });
    expect(rows).toEqual([]);
  });

  it("serialises query params and parses the response", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          rows: [
            { user_id: "u1", org_id: "org-1", action: "x", ts: 100 },
          ],
          count: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const mod = await import("../lib/audit");
    mod.__setAuditConfigForTesting({
      endpoint: "https://audit.example.com",
      bearer: "tok",
    });
    const rows = await mod.listAudit({
      orgId: "org-1",
      limit: 50,
      action: "x",
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("orgId=org-1");
    expect(url).toContain("limit=50");
    expect(url).toContain("action=x");
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe("u1");
  });
});
