/**
 * Encrypted sync UI (plan 3.4): passphrase form and the "freshness not
 * verified" banner, against a real E2eeSync on the simulated provider.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PassphraseForm, MIN_PASSPHRASE_LENGTH } from "../sync/e2ee/ui/PassphraseForm";
import { FreshnessBanner } from "../sync/e2ee/ui/FreshnessBanner";
import { PairingCompare } from "../sync/e2ee/ui/PairingCompare";
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
    render(<FreshnessBanner sync={c.sync} pollMs={20} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Freshness not verified");
    type("Pairing code from another device", "lumen-pair:2:0:AAAA");
    fireEvent.click(screen.getByText("Pair"));
    expect(await screen.findByText("This pairing code is not valid for this vault, or it has expired.")).toBeTruthy();
    type("Pairing code from another device", await a.sync.pairingCode());
    fireEvent.click(screen.getByText("Pair"));
    // W8.5: nothing is paired until the symbols were compared on both devices.
    await screen.findByTestId("pairing-compare");
    expect((await c.sync.freshness()).verified).toBe(false);
    let theirs: Awaited<ReturnType<typeof a.sync.pairingSas>> = null;
    await waitFor(async () => expect((theirs = await a.sync.pairingSas())).not.toBeNull());
    const shown = await screen.findByTestId("pairing-symbols");
    expect([...shown.querySelectorAll("li")].map((li) => li.children[1]!.textContent)).toEqual(theirs!.emoji);
    fireEvent.click(screen.getByText("They match"));
    expect(await screen.findByText("Confirmed on this device. Now choose “They match” on the other one.")).toBeTruthy();
    expect((await c.sync.freshness()).verified).toBe(false);
    await waitFor(async () => expect(await a.sync.confirmPairing()).toBe("done"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Freshness verified"));
    expect((await c.sync.freshness()).source).toBe("paired");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("W8.5: \"They don't match\" stops the pairing on the new device, and nothing is paired", async () => {
    const provider = memoryProvider();
    const a = await newVault(provider);
    await a.sync.sync();
    const c = await joinVault("C", provider);
    await c.sync.sync();
    render(<FreshnessBanner sync={c.sync} pollMs={20} />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByText("Show a pairing request"));
    const request = (await screen.findByDisplayValue(/^lumen-pair-request:/)) as HTMLTextAreaElement;
    type("Pairing code from another device", await a.sync.answerPairing(request.value));
    fireEvent.click(screen.getByText("Pair"));
    await screen.findByTestId("pairing-symbols");
    fireEvent.click(screen.getByText("They don't match"));
    expect(await screen.findByText("Pairing stopped, and nothing was paired. Start again, and pair only with the device in front of you.")).toBeTruthy();
    expect((await c.sync.freshness()).verified).toBe(false);
    expect(c.store.state!.pairRequest).toBeUndefined();
  });

  it("W8.5: on the existing device, the same symbols; it finishes once the new device's user confirmed too", async () => {
    const provider = memoryProvider();
    const a = await newVault(provider);
    await a.sync.sync();
    const c = await joinVault("C", provider);
    await c.sync.sync();
    await c.sync.pair(await a.sync.answerPairing(await c.sync.pairingRequest()));
    const ends: string[] = [];
    render(<PairingCompare sync={a.sync} pollMs={20} onEnd={(o) => ends.push(o)} />);
    const shown = await screen.findByTestId("pairing-symbols");
    expect(shown.getAttribute("dir")).toBe("ltr"); // the same order on a Hebrew and an English device
    expect([...shown.querySelectorAll("li")].map((li) => li.children[1]!.textContent)).toEqual((await c.sync.pairingSas())!.emoji);
    fireEvent.click(screen.getByText("They match"));
    await screen.findByText("Confirmed on this device. Now choose “They match” on the other one.");
    expect(await c.sync.confirmPairing()).toBe("done");
    expect(await screen.findByText("Paired: the symbols were confirmed on both devices.")).toBeTruthy();
    expect(ends).toEqual(["done"]);
    expect((await c.sync.freshness()).source).toBe("paired");
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

  it("exposes the core through one lazy entry", () => {
    expect(typeof e2ee.createVault).toBe("function");
    expect(typeof e2ee.E2eeSync).toBe("function");
    expect(e2ee.PBKDF2_MIN_ITERATIONS).toBeGreaterThanOrEqual(600_000);
    expect(e2ee.PROTOCOL_VERSION).toBe(1);
  });
});
