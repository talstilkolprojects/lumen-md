/**
 * Encrypted sync UI (plan 3.4): passphrase form and the "freshness not
 * verified" banner, against a real E2eeSync on the simulated provider.
 */

import { describe, it, expect, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { HISTORY_LENGTH } from "../sync/e2ee/manifest";
import { PassphraseForm, MIN_PASSPHRASE_LENGTH } from "../sync/e2ee/ui/PassphraseForm";
import { FreshnessBanner } from "../sync/e2ee/ui/FreshnessBanner";
import { WrongPassphraseError } from "../sync/e2ee/header";
import { memoryProvider } from "../sync/e2ee/provider";
import * as e2ee from "../sync/e2ee";
import { joinVault, newVault } from "./helpers/e2ee";

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("e2ee passphrase form", () => {
  it("create: enforces the minimum length and a matching repeat", async () => {
    const onSubmit = vi.fn(async () => {});
    render(<PassphraseForm mode="create" onSubmit={onSubmit} />);
    expect(screen.getByText("Encrypted sync")).toBeTruthy();
    type("Passphrase", "short");
    type("Repeat the passphrase", "short");
    fireEvent.click(screen.getByText("Encrypt and sync"));
    expect((await screen.findByRole("alert")).textContent).toBe(`At least ${MIN_PASSPHRASE_LENGTH} characters.`);
    type("Passphrase", "סיסמה ארוכה מספיק");
    type("Repeat the passphrase", "סיסמה ארוכה מספיק!");
    fireEvent.click(screen.getByText("Encrypt and sync"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("The passphrases do not match."));
    type("Repeat the passphrase", "סיסמה ארוכה מספיק");
    fireEvent.click(screen.getByText("Encrypt and sync"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("סיסמה ארוכה מספיק"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("unlock: shows a wrong passphrase, and other errors as they are", async () => {
    let fail: Error = new WrongPassphraseError();
    render(
      <PassphraseForm
        mode="unlock"
        onSubmit={async () => {
          throw fail;
        }}
      />,
    );
    expect(screen.queryByLabelText("Repeat the passphrase")).toBeNull();
    type("Passphrase", "x");
    fireEvent.click(screen.getByText("Unlock"));
    expect((await screen.findByRole("alert")).textContent).toBe("Wrong passphrase.");
    fail = new Error("offline");
    fireEvent.click(screen.getByText("Unlock"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("offline"));
  });
});

describe("e2ee freshness banner", () => {
  it("warns on an unpaired device until pairing, and refuses a bad code", async () => {
    const provider = memoryProvider();
    const a = await newVault(provider);
    await a.sync.sync();
    const c = await joinVault("C", provider);
    await c.sync.sync();
    render(<FreshnessBanner sync={c.sync} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Freshness not verified");
    type("Pairing code from another device", "lumen-pair:1:AAAA");
    fireEvent.click(screen.getByText("Pair"));
    expect(await screen.findByText("This pairing code is not valid for this vault, or it has expired.")).toBeTruthy();
    type("Pairing code from another device", await a.sync.pairingCode());
    fireEvent.click(screen.getByText("Pair"));
    expect((await screen.findByRole("status")).textContent).toBe("Freshness verified");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("confirming by hand clears the warning; a creator never sees it", async () => {
    const provider = memoryProvider();
    const a = await newVault(provider);
    const d = await joinVault("D", provider);
    await d.sync.sync();
    const { unmount } = render(<FreshnessBanner sync={d.sync} />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByText("I checked — it is current"));
    expect((await screen.findByRole("status")).textContent).toBe("Freshness verified");
    expect(await d.sync.freshness()).toMatchObject({ source: "confirmed" });
    unmount();
    render(<FreshnessBanner sync={a.sync} />);
    expect((await screen.findByRole("status")).textContent).toBe("Freshness verified");
  });

  it("re-reads after every round: a round that revokes the verification brings the warning back (2.31)", async () => {
    const provider = memoryProvider();
    const a = await newVault(provider);
    await a.sync.sync();
    const c = await joinVault("C", provider);
    await c.sync.sync();
    await c.sync.pair(await a.sync.pairingCode());
    render(<FreshnessBanner sync={c.sync} />);
    expect((await screen.findByRole("status")).textContent).toBe("Freshness verified");
    for (let i = 0; i < HISTORY_LENGTH + 1; i++) {
      a.files.set("n.md", `v${i}`);
      await a.sync.sync();
    }
    await c.sync.sync();
    expect((await screen.findByRole("alert")).textContent).toContain("Freshness not verified");
    expect(screen.queryByText("Freshness verified")).toBeNull();
  });

  it("shows nothing, never 'verified', while freshness is unknown", async () => {
    let listener: () => void = () => {};
    let answer: (f: { source: "paired"; verified: boolean; counter: number }) => void = () => {};
    let calls = 0;
    const fake = {
      freshness: vi.fn(() => {
        calls++;
        if (calls === 1) return Promise.resolve({ source: "paired" as const, verified: true, counter: 3 });
        if (calls === 2) return new Promise<{ source: "paired"; verified: boolean; counter: number }>((r) => (answer = r));
        return Promise.reject(new Error("store unavailable"));
      }),
      pair: vi.fn(async () => {}),
      confirmFreshness: vi.fn(async () => {}),
      onChange: (l: () => void) => ((listener = l), () => {}),
    };
    const { container } = render(<FreshnessBanner sync={fake as never} />);
    expect((await screen.findByRole("status")).textContent).toBe("Freshness verified");
    // A round ended: until the re-read answers, nothing is shown.
    act(() => listener());
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => answer({ source: "paired", verified: true, counter: 4 }));
    expect((await screen.findByRole("status")).textContent).toBe("Freshness verified");
    // A re-read that fails leaves it unknown: nothing.
    await act(async () => listener());
    await waitFor(() => expect(container.textContent).toBe(""));
  });

  it("exposes the core through one lazy entry", () => {
    expect(typeof e2ee.createVault).toBe("function");
    expect(typeof e2ee.E2eeSync).toBe("function");
    expect(e2ee.PBKDF2_MIN_ITERATIONS).toBeGreaterThanOrEqual(600_000);
    expect(e2ee.PROTOCOL_VERSION).toBe(1);
  });
});
