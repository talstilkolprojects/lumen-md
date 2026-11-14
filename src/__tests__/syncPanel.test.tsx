/**
 * The sync panel and its session (plan 3.5): connect a provider, create or
 * unlock the vault, sync, disconnect — against the mock WebDAV server.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createSession } from "../sync/e2ee/ui/session";
import { SyncPanel } from "../sync/e2ee/ui/SyncPanel";
import { memoryFiles } from "../sync/e2ee/localFiles";
import { memoryStateStore } from "../sync/e2ee/state";
import { keepBothResolver } from "../sync/e2ee/conflict";
import { WrongPassphraseError } from "../sync/e2ee/header";
import { __setProviderStore, loadProviderSettings, type ProviderSettings } from "../sync/e2ee/providers";
import { getSecret, __resetSecretStore } from "../lib/secretStore";
import { fakeFetch, text } from "./helpers/fakeServers/http";
import { fakeWebdav } from "./helpers/fakeServers/webdav";
import { PASSPHRASE, TEST_ITERATIONS } from "./helpers/e2ee";

const URL_ = "https://dav.example/remote.php/dav/files/tal/Lumen/";
const kv = new Map<string, unknown>();
beforeEach(() => {
  kv.clear();
  __setProviderStore({ get: async <T,>(k: string) => kv.get(k) as T | undefined, set: async (k, v) => void kv.set(k, v), del: async (k) => void kv.delete(k) });
});
afterEach(() => {
  __setProviderStore(null);
  __resetSecretStore();
});

function lab() {
  const server = fakeWebdav({ baseUrl: URL_, username: "tal", password: "pw" });
  const device = () => {
    const files = memoryFiles();
    const session = createSession({
      fetch: fakeFetch(server.handle),
      local: () => files,
      store: async () => memoryStateStore(),
      resolver: keepBothResolver,
      pbkdf2Iterations: TEST_ITERATIONS,
      kdfPolicy: { minPbkdf2Iterations: TEST_ITERATIONS },
      intervalMinutes: 0,
    });
    return { files, session };
  };
  return { server, device };
}
const webdav: ProviderSettings = { kind: "webdav", url: URL_, username: "tal" };

describe("sync session", () => {
  it("first device creates the vault, the second unlocks it and gets the notes", async () => {
    const { server, device } = lab();
    const a = device();
    await a.session.connect(webdav, "pw");
    expect(a.session.get()).toMatchObject({ phase: "connected", vaultExists: false });
    expect(getSecret("lumen.sync.webdav.password")).toBe("pw");
    expect(await loadProviderSettings()).toEqual(webdav);
    await a.files.write("notes/שלום.md", text("# שלום"), null);
    const first = await a.session.open(PASSPHRASE);
    expect(first.uploaded).toBe(1);
    expect(a.session.get().phase).toBe("unlocked");

    const b = device();
    await b.session.connect(webdav, null); // the stored password
    expect(b.session.get().vaultExists).toBe(true);
    await expect(b.session.open("not the passphrase")).rejects.toBeInstanceOf(WrongPassphraseError);
    expect((await b.session.open(PASSPHRASE)).downloaded).toBe(1);
    expect(b.files.text("notes/שלום.md")).toBe("# שלום");
    // Only ciphertext at the server.
    for (const f of server.files.values()) expect(new TextDecoder().decode(f.data)).not.toContain("שלום");
  });

  it("lock forgets the keys; disconnect forgets the provider and deletes nothing there", async () => {
    const { server, device } = lab();
    const a = device();
    await a.session.connect(webdav, "pw");
    await a.session.open(PASSPHRASE);
    a.session.lock();
    expect(a.session.get().phase).toBe("connected");
    await expect(a.session.syncNow()).rejects.toThrow(/locked/);
    const before = server.files.size;
    await a.session.disconnect();
    expect(a.session.get().phase).toBe("disconnected");
    expect(await loadProviderSettings()).toBeNull();
    expect(getSecret("lumen.sync.webdav.password")).toBeNull();
    expect(server.files.size).toBe(before);
  });
});

describe("sync panel", () => {
  const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

  it("connects WebDAV, creates the vault and shows the round", async () => {
    const { device } = lab();
    const a = device();
    await a.files.write("a.md", text("alpha"), null);
    render(<SyncPanel session={a.session} onClose={() => undefined} />);
    await screen.findByText("Where to keep the encrypted vault");
    // Dropbox and Drive are disabled without Lumen's app ids (plan 15.5).
    expect((screen.getByDisplayValue("dropbox") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByDisplayValue("gdrive") as HTMLInputElement).disabled).toBe(true);
    type("Folder address", URL_);
    type("User name", "tal");
    type("Password or app password", "wrong");
    fireEvent.click(screen.getByText("Connect"));
    expect((await screen.findByRole("alert")).textContent).toBe("The server refused the credentials.");
    type("Password or app password", "pw");
    fireEvent.click(screen.getByText("Connect"));
    await screen.findByText("There is no vault there yet. Choose a passphrase to create it.");
    type("Passphrase", PASSPHRASE);
    type("Repeat the passphrase", PASSPHRASE);
    fireEvent.click(screen.getByText("Encrypt and sync"));
    await waitFor(() => expect(screen.getByTestId("sync-result").textContent).toMatch(/1 up, 0 down, 0 deleted/));
    expect(screen.getByText("Connected: WebDAV — dav.example")).toBeTruthy();
  });

  it("explains a server the browser cannot reach (CORS / CSP)", async () => {
    const session = createSession({
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
      intervalMinutes: 0,
    });
    render(<SyncPanel session={session} onClose={() => undefined} />);
    await screen.findByText("Where to keep the encrypted vault");
    type("Folder address", "https://nas.local:5006/lumen/");
    type("Password or app password", "x");
    fireEvent.click(screen.getByText("Connect"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not reach nas\.local:5006.*CORS.*VITE_CSP_CONNECT_EXTRA/);
  });
});
