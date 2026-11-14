import { describe, it, expect } from "vitest";
import { connectAllowedByCsp } from "../lib/cspConnect";
import { endpointOrigins } from "../build/cspEndpoints";

const SRC = ["'self'", "blob:", "wss:", "https://api.openai.com", "http://localhost:11434", "https://*.supabase.co"];

describe("connectAllowedByCsp", () => {
  it("allows listed origins, scheme sources, wildcards and self", () => {
    expect(connectAllowedByCsp("https://api.openai.com/v1/chat", SRC)).toBe(true);
    expect(connectAllowedByCsp("http://localhost:11434/api/tags", SRC)).toBe(true);
    expect(connectAllowedByCsp("wss://anything.example/ws", SRC)).toBe(true);
    expect(connectAllowedByCsp("https://abc.supabase.co/rest", SRC)).toBe(true);
    expect(connectAllowedByCsp(`${location.origin}/x`, SRC)).toBe(true);
  });

  it("rejects origins the policy would block (runtime overrides)", () => {
    expect(connectAllowedByCsp("https://market.evil.test/items", SRC)).toBe(false);
    expect(connectAllowedByCsp("http://192.168.1.20:11434", SRC)).toBe(false);
    expect(connectAllowedByCsp("http://localhost:9999", SRC)).toBe(false);
    expect(connectAllowedByCsp("https://supabase.co", SRC)).toBe(false);
  });

  it("'self' covers the page host's WebSocket and secure schemes (CSP3), nothing else", () => {
    const self = ["'self'"];
    const host = location.host;
    expect(connectAllowedByCsp(`ws://${host}/hmr`, self)).toBe(location.protocol === "http:");
    expect(connectAllowedByCsp(`wss://${host}/hmr`, self)).toBe(true);
    expect(connectAllowedByCsp(`wss://other.example/hmr`, self)).toBe(false);
  });

  it("explicit WebSocket hosts (plan 2.2: the policies carry no bare wss:)", () => {
    const list = ["'self'", "wss://signal.example.com", "ws://*:5173"];
    expect(connectAllowedByCsp("wss://signal.example.com", list)).toBe(true);
    expect(connectAllowedByCsp("wss://signal.example.com:8443", list)).toBe(false);
    expect(connectAllowedByCsp("ws://signal.example.com", list)).toBe(false);
    expect(connectAllowedByCsp("wss://my-signal.example.org", list)).toBe(false);
  });

  it("a bracketed IPv6 source allows nothing, as in browsers (Chromium ignores it as invalid)", () => {
    const list = ["'self'", "ws://[::1]:4444", "wss://[2001:db8::1]", "ws://127.0.0.1:4444"];
    expect(connectAllowedByCsp("ws://[::1]:4444/room", list)).toBe(false);
    expect(connectAllowedByCsp("wss://[2001:db8::1]/", list)).toBe(false);
    // An IPv4 address and names still work, and a bracket never bleeds into a name match.
    expect(connectAllowedByCsp("ws://127.0.0.1:4444/room", list)).toBe(true);
    expect(connectAllowedByCsp("ws://[::1]:4444", ["ws://[::1"])).toBe(false);
  });

  it("every origin the build adds is allowed at runtime; IPv6 ones are skipped with a reason", () => {
    const skipped: string[] = [];
    const origins = endpointOrigins(
      {
        VITE_WEBRTC_SIGNALING_URL: "ws://[::1]:4444, wss://signal.acme.dev, ws://127.0.0.1:4444",
        VITE_YJS_WEBSOCKET_URL: "wss://[2001:db8::7]:8443/rooms",
        VITE_WORKOS_ENDPOINT: "https://auth.acme.dev",
        VITE_CSP_CONNECT_EXTRA: "http://[fe80::1]:11434",
      },
      (value, reason) => skipped.push(`${value}: ${reason}`),
    );
    expect(origins).toEqual(["https://auth.acme.dev", "ws://127.0.0.1:4444", "wss://signal.acme.dev"]);
    expect(skipped).toHaveLength(3);
    expect(skipped.join("\n")).toMatch(/ws:\/\/\[::1\]:4444: .*IPv6.*use a hostname/);
    const list = ["'self'", ...origins];
    for (const url of ["ws://127.0.0.1:4444", "wss://signal.acme.dev", "https://auth.acme.dev/x"]) {
      expect(connectAllowedByCsp(url, list), url).toBe(true);
    }
  });

  it("allows everything when no policy is present", () => {
    expect(connectAllowedByCsp("https://anything.test", null)).toBe(true);
  });
});
