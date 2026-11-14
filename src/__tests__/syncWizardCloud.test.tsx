/**
 * Audit W10.C19 (plan W4.19): the guided sync setup lists Google Drive and
 * Dropbox, not only folder, relay and WebDAV.
 *  - In a build without their OAuth apps (today's), they are listed and
 *    disabled, each saying it is not in this build yet. They are never
 *    offered as if they worked.
 *  - With the OAuth app: signed in already → on to the key, in the wizard.
 *    Not signed in → the sign-in starts, is listed in the privacy ledger,
 *    and the choice is kept for the return.
 * Which OAuth apps the build has, and the Drive sign-in itself (a
 * redirect), are stood in for. The wizard and the ledger are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const build = vi.hoisted(() => ({ oauth: false, connected: false, connects: 0 }));
vi.mock("../sync/e2ee/providers", async (orig) => {
  const real = await orig<typeof import("../sync/e2ee/providers")>();
  const store = { name: "gdrive", isConnected: () => build.connected, connect: async () => void build.connects++, disconnect: async () => {} };
  return {
    ...real,
    oauthAvailable: (k: string) => (k === "gdrive" || k === "dropbox" ? build.oauth : real.oauthAvailable(k as never)),
    hasProviderSecret: (k: string) => (k === "gdrive" || k === "dropbox" ? build.connected : real.hasProviderSecret(k as never)),
    legacyStore: (k: string) => (k === "gdrive" || k === "dropbox" ? store : real.legacyStore(k as never)),
  };
});

import { SetupWizard } from "../sync/e2ee/ui/SetupWizard";
import { createSession } from "../sync/e2ee/ui/session";
import { memoryFiles } from "../sync/e2ee/localFiles";
import { memoryStateStore } from "../sync/e2ee/state";
import { keepBothResolver } from "../sync/e2ee/conflict";
import { takePendingOAuth } from "../sync/e2ee/ui/SyncPanel";
import { ledgerEntries } from "../ai/privacyLedger";

const session = () =>
  createSession({ fetch: async () => new Response("", { status: 500 }), local: () => memoryFiles(), store: async () => memoryStateStore(), resolver: keepBothResolver, intervalMinutes: 0, treeBadges: false, background: false, watch: () => () => undefined });
const wizard = () => render(<SetupWizard folderAccess={false} relay="https://relay.example" session={session()} onClose={() => undefined} onAdvanced={() => undefined} />);
const destinations = () => [...document.querySelectorAll<HTMLInputElement>('input[name="sync-where"]')].map((i) => `${i.value}${i.disabled ? ":disabled" : ""}`);

beforeEach(() => Object.assign(build, { oauth: false, connected: false, connects: 0 }));
afterEach(() => cleanup());

describe("the sync setup's Drive and Dropbox (W10.C19)", () => {
  it("this build (no OAuth apps): 4 places listed, Drive and Dropbox disabled and saying why", () => {
    wizard();
    expect(destinations()).toEqual(["relay", "webdav", "gdrive:disabled", "dropbox:disabled"]);
    expect(screen.getByTestId("sync-where-gdrive-unready").textContent).toMatch(/Not in this build yet: Google Drive/);
    expect(screen.getByTestId("sync-where-dropbox-unready").textContent).toMatch(/Dropbox/);
  });

  it("with the OAuth app and signed in already: Drive goes on to the key in the wizard", async () => {
    Object.assign(build, { oauth: true, connected: true });
    wizard();
    expect(destinations()).toEqual(["relay", "gdrive", "dropbox", "webdav"]);
    fireEvent.click(screen.getByTestId("sync-where-gdrive"));
    fireEvent.click(screen.getByTestId("sync-setup-continue"));
    await waitFor(() => expect(screen.getByTestId("sync-setup-words")).toBeTruthy());
    expect(build.connects).toBe(0);
  });

  it("with the OAuth app, not signed in: the sign-in starts, is in the privacy ledger, and the choice waits for the return", async () => {
    build.oauth = true;
    wizard();
    fireEvent.click(screen.getByTestId("sync-where-gdrive"));
    fireEvent.click(screen.getByTestId("sync-setup-continue"));
    await waitFor(() => expect(build.connects).toBe(1));
    expect(takePendingOAuth()).toEqual({ kind: "gdrive", folderName: "Lumen Vault" });
    expect(ledgerEntries().some((e) => e.host === "accounts.google.com" && /Google Drive/.test(e.reason))).toBe(true);
  });
});
