/** Plan 3.3 — the CORS proxy for git is configurable and has no built-in host. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authFor,
  getCorsProxy,
  getStoredCorsProxy,
  looksLikeCorsFailure,
  normaliseProxyUrl,
  resolveCorsProxy,
  setStoredCorsProxy,
} from "../sync/gitProxy";

afterEach(() => setStoredCorsProxy(null));

describe("CORS proxy setting", () => {
  it("has no default host: without a setting, git connects directly", () => {
    expect(resolveCorsProxy(null, undefined)).toBeUndefined();
    expect(resolveCorsProxy("", "")).toBeUndefined();
  });

  it("the user's setting wins over the build's", () => {
    expect(resolveCorsProxy("http://localhost:9999/", "https://git-proxy.example.com")).toBe("http://localhost:9999");
    expect(resolveCorsProxy(null, "https://git-proxy.example.com")).toBe("https://git-proxy.example.com");
  });

  it("accepts http(s) URLs only", () => {
    expect(normaliseProxyUrl("https://proxy.example.com/git/")).toBe("https://proxy.example.com/git");
    expect(normaliseProxyUrl("javascript:alert(1)")).toBeNull();
    expect(normaliseProxyUrl("ftp://proxy.example.com")).toBeNull();
    expect(normaliseProxyUrl("https://user:pw@proxy.example.com")).toBeNull();
    expect(normaliseProxyUrl("not a url")).toBeNull();
    expect(() => setStoredCorsProxy("nope")).toThrow();
  });

  it("keeps the setting for the page when localStorage refuses it", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    try {
      setStoredCorsProxy("http://localhost:9999");
      expect(getCorsProxy()).toBe("http://localhost:9999");
    } finally {
      spy.mockRestore();
    }
  });

  it("is stored, read back and cleared", () => {
    setStoredCorsProxy("http://localhost:9999");
    expect(getStoredCorsProxy()).toBe("http://localhost:9999");
    expect(getCorsProxy()).toBe("http://localhost:9999");
    setStoredCorsProxy("");
    expect(getStoredCorsProxy()).toBeNull();
  });
});

describe("auth", () => {
  it("sends credentials only when there is a token", () => {
    expect(authFor("")).toEqual({});
    expect(authFor(null)).toEqual({});
    expect(authFor("ghp_x").onAuth?.()).toEqual({ username: "ghp_x", password: "x-oauth-basic" });
  });

  it("tells a blocked request (CORS) from a git error", () => {
    expect(looksLikeCorsFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(looksLikeCorsFailure(Object.assign(new Error("HTTP Error: 401"), { code: "HttpError" }))).toBe(false);
    expect(looksLikeCorsFailure(null)).toBe(false);
  });
});
