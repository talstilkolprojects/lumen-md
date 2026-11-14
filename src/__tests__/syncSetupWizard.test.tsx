/**
 * Plan W4.19: the guided setup, clicked through for two devices against an
 * in-memory relay (the same protocol as sync-server/vault-relay.js). Counts
 * the clicks each device needs, and checks the key-loss warning comes first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeQr, qrPath } from "../lib/qr";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SetupWizard } from "../sync/e2ee/ui/SetupWizard";
import { createSession } from "../sync/e2ee/ui/session";
import { memoryFiles } from "../sync/e2ee/localFiles";
import { memoryStateStore } from "../sync/e2ee/state";
import { keepBothResolver } from "../sync/e2ee/conflict";
import { __setProviderStore } from "../sync/e2ee/providers";
import { __resetSecretStore } from "../lib/secretStore";
import { TEST_ITERATIONS } from "./helpers/e2ee";

const RELAY = "https://relay.example";

/** A relay in memory: one space per bearer token, ETags, If-Match / If-None-Match. */
function memoryRelay() {
  const spaces = new Map<string, Map<string, { data: Uint8Array; etag: string }>>();
  let n = 0;
  const fetch = async (input: Request | string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const h = new Headers(init.headers);
    const token = /^Bearer (.+)$/.exec(h.get("Authorization") ?? "")?.[1];
    if (!token) return new Response("", { status: 401 });
    const space = spaces.get(token) ?? new Map();
    spaces.set(token, space);
    const name = decodeURIComponent(url.pathname.replace("/v1/vault/o/", ""));
    const method = init.method ?? "GET";
    if (!name) return new Response(JSON.stringify({ names: [...space.keys()] }), { status: 200 });
    const now = space.get(name);
    if (method === "GET") return now ? new Response(now.data as BodyInit, { status: 200, headers: { ETag: now.etag } }) : new Response("", { status: 404 });
    if (method === "DELETE") return space.delete(name), new Response(null, { status: 204 });
    if (h.get("If-None-Match") === "*" && now) return new Response("", { status: 412 });
    const ifMatch = h.get("If-Match");
    if (ifMatch && (!now || now.etag !== ifMatch)) return new Response("", { status: 412 });
    const data = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
    const etag = `"e${++n}"`;
    space.set(name, { data, etag });
    return new Response(null, { status: 201, headers: { ETag: etag } });
  };
  return { fetch, spaces };
}

const kv = new Map<string, unknown>();
beforeEach(() => {
  kv.clear();
  __setProviderStore({ get: async <T,>(k: string) => kv.get(k) as T | undefined, set: async (k, v) => void kv.set(k, v), del: async (k) => void kv.delete(k) });
});
afterEach(() => {
  cleanup();
  __setProviderStore(null);
  __resetSecretStore();
});

function device(fetch: ReturnType<typeof memoryRelay>["fetch"]) {
  const files = memoryFiles();
  const session = createSession({
    fetch,
    local: () => files,
    store: async () => memoryStateStore(),
    resolver: keepBothResolver,
    pbkdf2Iterations: TEST_ITERATIONS,
    kdfPolicy: { minPbkdf2Iterations: TEST_ITERATIONS },
    intervalMinutes: 0,
    treeBadges: false,
    background: false,
    watch: () => () => undefined,
  });
  return { files, session };
}

describe("SetupWizard", () => {
  it("first device: 2 clicks; second device: 3 clicks with the pasted words; every file synced", async () => {
    const relay = memoryRelay();
    const a = device(relay.fetch);
    await a.files.write("פתק.md", new TextEncoder().encode("# שלום"), null);
    let clicks = 0;
    const click = (el: Element) => (clicks++, fireEvent.click(el));

    render(<SetupWizard folderAccess={false} relay={RELAY} session={a.session} onClose={() => undefined} onAdvanced={() => undefined} />);
    // The relay is chosen already (no folder access here).
    expect((screen.getByTestId("sync-where-relay") as HTMLInputElement).checked).toBe(true);
    click(screen.getByTestId("sync-setup-continue"));
    const list = await waitFor(() => screen.getByTestId("sync-setup-words"));
    const words = [...list.querySelectorAll("li")].map((li) => li.textContent ?? "");
    expect(words).toHaveLength(13);
    // The loss of the key is explained before anything starts.
    expect(screen.getByRole("note").textContent).toMatch(/lost|אבוד/);
    const ask = screen.getByText(/word number|מילה מספר/).textContent ?? "";
    const n = Number(/(\d+)/.exec(ask)![1]);
    // A wrong word is refused.
    fireEvent.change(screen.getByTestId("sync-setup-check"), { target: { value: words[n % 13] === words[n - 1] ? "xyz" : words[n % 13] } });
    click(screen.getByTestId("sync-setup-start"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/\d/));
    clicks--; // the refused attempt does not count
    fireEvent.change(screen.getByTestId("sync-setup-check"), { target: { value: words[n - 1] } });
    click(screen.getByTestId("sync-setup-start"));
    await waitFor(() => screen.getByTestId("sync-setup-counts"), { timeout: 8000 });
    expect(clicks).toBe(2);
    expect(screen.getByTestId("sync-setup-counts").textContent).toMatch(/1/);
    cleanup();

    // Second device: the place already holds a vault, so it asks for the words.
    const b = device(relay.fetch);
    clicks = 0;
    render(<SetupWizard folderAccess={false} relay={RELAY} session={b.session} onClose={() => undefined} onAdvanced={() => undefined} />);
    click(screen.getByTestId("sync-setup-continue"));
    await waitFor(() => screen.getByTestId("sync-setup-start"));
    click(screen.getByText(/already have a key|כבר יש לי מפתח/));
    fireEvent.change(screen.getByTestId("sync-setup-join"), { target: { value: words.join(" ") } });
    click(screen.getByTestId("sync-setup-start"));
    await waitFor(() => screen.getByTestId("sync-setup-counts"), { timeout: 8000 });
    expect(clicks).toBe(3);
    expect(new TextDecoder().decode((await b.files.read("פתק.md"))!)).toBe("# שלום");
    // The relay holds only ciphertext.
    const stored = [...relay.spaces.values()].flatMap((s) => [...s.values()]).map((o) => new TextDecoder().decode(o.data)).join("");
    expect(stored).not.toContain("שלום");
  });

  it("shows the key's words as a QR code only when asked, and never logs them (W10.C20)", async () => {
    const relay = memoryRelay();
    const a = device(relay.fetch);
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" "))));
    try {
      render(<SetupWizard folderAccess={false} relay={RELAY} session={a.session} onClose={() => undefined} onAdvanced={() => undefined} />);
      fireEvent.click(screen.getByTestId("sync-setup-continue"));
      const list = await waitFor(() => screen.getByTestId("sync-setup-words"));
      const words = [...list.querySelectorAll("li")].map((li) => li.textContent ?? "");
      expect(screen.queryByTestId("sync-setup-qr")).toBeNull();
      fireEvent.click(screen.getByTestId("sync-setup-qr-toggle"));
      const fig = screen.getByTestId("sync-setup-qr");
      // The symbol is the encoder's for exactly the words the other device types.
      const expected = qrPath(encodeQr(words.join(" "), "M"));
      expect(fig.querySelector("path")!.getAttribute("d")).toBe(expected);
      expect(fig.querySelector("svg")!.getAttribute("aria-label")).toMatch(/QR/);
      fireEvent.click(screen.getByTestId("sync-setup-qr-toggle"));
      expect(screen.queryByTestId("sync-setup-qr")).toBeNull();
      for (const w of words) expect(logged.join("\n")).not.toContain(w);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

