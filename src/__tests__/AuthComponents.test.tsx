/**
 * Sign-in surfaces (src/components/AuthButton.tsx, AuthDialog.tsx):
 * which controls each provider offers, what a submit / OAuth / SSO click
 * does, how errors read, and that the copy follows the active locale.
 *
 * The auth store is the real one; only the provider behind it is a fake,
 * so the dialog drives the same signIn / signUp / signOut actions the app
 * uses. WorkOS SSO is switched on per test through a mocked
 * `isWorkosEnabled` (the real one reads a build-time env variable).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { AuthProvider, User } from "../auth/types";

const sso = vi.hoisted(() => ({
  enabled: false,
  signInWithSso: vi.fn<(domain: string) => Promise<string>>(),
}));

vi.mock("../auth/workosProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/workosProvider")>()),
  isWorkosEnabled: () => sso.enabled,
  signInWithSso: (domain: string) => sso.signInWithSso(domain),
}));

import { useAuth } from "../auth/useAuth";
import { localProvider } from "../auth/localProvider";
import { AuthDialog } from "../components/AuthDialog";
import { AuthButton } from "../components/AuthButton";
import { applyLocale, loadLocale, t } from "../i18n";

const USER: User = { id: "u1", email: "dana@example.com", name: "dana", provider: "fake" };

function fakeProvider(overrides: Partial<AuthProvider> = {}): AuthProvider {
  return {
    name: "fake",
    loadSession: async () => null,
    signInWithPassword: vi.fn(async () => USER),
    signUpWithPassword: vi.fn(async () => USER),
    signInWithProvider: vi.fn(async () => USER),
    signOut: vi.fn(async () => {}),
    ...overrides,
  };
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  sso.enabled = false;
  sso.signInWithSso.mockReset();
  localStorage.clear();
  useAuth.setState({ status: "anonymous", user: null, error: undefined, provider: localProvider });
});

afterEach(() => {
  cleanup();
  applyLocale("en");
});

describe("AuthDialog", () => {
  it("renders nothing while closed", () => {
    const { container } = render(<AuthDialog open={false} onClose={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("explains how to enable accounts when only the local provider exists", () => {
    render(<AuthDialog open onClose={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain(t("auth.status.notConfigured"));
    expect(dialog.textContent).toContain("VITE_SUPABASE_URL");
    // No form controls: nothing to sign in with.
    expect(screen.queryByLabelText(t("auth.dialog.email"))).toBeNull();
    const link = screen.getByRole("link", { name: t("toast.learnMore") });
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("closes on Escape, on the backdrop and on the Close button — not on a click inside", () => {
    const onClose = vi.fn();
    render(<AuthDialog open onClose={onClose} />);
    fireEvent.click(screen.getByText(t("auth.dialog.intro")));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("dialog"));
    fireEvent.click(screen.getByRole("button", { name: t("auth.dialog.close") }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("signs in with email + password and closes", async () => {
    const provider = fakeProvider();
    useAuth.setState({ provider });
    const onClose = vi.fn();
    render(<AuthDialog open onClose={onClose} />);
    fill(t("auth.dialog.email"), "dana@example.com");
    fill(t("auth.dialog.password"), "correct-horse");
    fireEvent.click(screen.getByRole("button", { name: t("auth.signIn") }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(provider.signInWithPassword).toHaveBeenCalledWith("dana@example.com", "correct-horse");
    expect(useAuth.getState().status).toBe("authenticated");
    expect(useAuth.getState().user?.email).toBe("dana@example.com");
  });

  it("shows an actionable message instead of the raw provider error", async () => {
    const provider = fakeProvider({
      signInWithPassword: vi.fn(async () => {
        throw new Error("Invalid login credentials");
      }),
    });
    useAuth.setState({ provider });
    const onClose = vi.fn();
    render(<AuthDialog open onClose={onClose} />);
    fill(t("auth.dialog.email"), "dana@example.com");
    fill(t("auth.dialog.password"), "wrong-password");
    fireEvent.click(screen.getByRole("button", { name: t("auth.signIn") }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(t("auth.error.invalidCredentials"));
    expect(alert.textContent).not.toContain("Invalid login credentials");
    expect(onClose).not.toHaveBeenCalled();
    // The submit button is usable again after the failure.
    expect(screen.getByRole("button", { name: t("auth.signIn") }).hasAttribute("disabled")).toBe(false);
  });

  it("switches to sign-up and back", async () => {
    const provider = fakeProvider();
    useAuth.setState({ provider });
    const onClose = vi.fn();
    render(<AuthDialog open onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: t("auth.dialog.needAccount") }));
    expect(screen.getByText(t("auth.dialog.signUpTitle"))).toBeTruthy();
    expect(screen.getByLabelText(t("auth.dialog.password")).getAttribute("autocomplete")).toBe("new-password");
    fill(t("auth.dialog.email"), "new@example.com");
    fill(t("auth.dialog.password"), "a-new-password");
    fireEvent.click(screen.getByRole("button", { name: t("auth.dialog.createAccount") }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(provider.signUpWithPassword).toHaveBeenCalledWith("new@example.com", "a-new-password");
    expect(provider.signInWithPassword).not.toHaveBeenCalled();
  });

  it("toggling back from sign-up restores the sign-in form", () => {
    useAuth.setState({ provider: fakeProvider() });
    render(<AuthDialog open onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: t("auth.dialog.needAccount") }));
    fireEvent.click(screen.getByRole("button", { name: t("auth.dialog.haveAccount") }));
    expect(screen.getByLabelText(t("auth.dialog.password")).getAttribute("autocomplete")).toBe("current-password");
  });

  it("offers Google and GitHub when the provider supports OAuth", async () => {
    const provider = fakeProvider();
    useAuth.setState({ provider });
    const onClose = vi.fn();
    render(<AuthDialog open onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: t("auth.dialog.github") }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(provider.signInWithProvider).toHaveBeenCalledWith("github");
    fireEvent.click(screen.getByRole("button", { name: t("auth.dialog.google") }));
    await waitFor(() => expect(provider.signInWithProvider).toHaveBeenCalledWith("google"));
  });

  it("reports a failed OAuth sign-in", async () => {
    useAuth.setState({
      provider: fakeProvider({
        signInWithProvider: vi.fn(async () => {
          throw new TypeError("Failed to fetch");
        }),
      }),
    });
    render(<AuthDialog open onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: t("auth.dialog.google") }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(t("auth.error.network"));
  });

  it("surfaces a boot-time provider failure up front", () => {
    useAuth.setState({ provider: fakeProvider(), status: "error", error: "Failed to fetch" });
    render(<AuthDialog open onClose={() => {}} />);
    expect(screen.getByRole("alert").textContent).toContain(t("auth.error.network"));
  });

  it("hides password controls for an OAuth-only provider", () => {
    useAuth.setState({
      provider: fakeProvider({ signInWithPassword: undefined, signUpWithPassword: undefined }),
    });
    render(<AuthDialog open onClose={() => {}} />);
    expect(screen.queryByLabelText(t("auth.dialog.email"))).toBeNull();
    expect(screen.queryByRole("button", { name: t("auth.dialog.needAccount") })).toBeNull();
    expect(screen.getByRole("button", { name: t("auth.dialog.google") })).toBeTruthy();
  });

  it("SSO: pre-fills the organization domain and follows the IdP redirect", async () => {
    sso.enabled = true;
    sso.signInWithSso.mockResolvedValue("#sso-redirect");
    localStorage.setItem("lumen.org.settings", JSON.stringify({ name: "Acme", domains: ["acme.example.com"] }));
    render(<AuthDialog open onClose={() => {}} />);
    const domain = screen.getByLabelText(t("auth.dialog.ssoDomain")) as HTMLInputElement;
    expect(domain.value).toBe("acme.example.com");
    expect(domain.getAttribute("dir")).toBe("ltr");
    fireEvent.change(domain, { target: { value: "  other.example.com  " } });
    fireEvent.click(screen.getByRole("button", { name: t("auth.dialog.ssoContinue") }));
    await waitFor(() => expect(window.location.hash).toBe("#sso-redirect"));
    expect(sso.signInWithSso).toHaveBeenCalledWith("other.example.com");
    window.location.hash = "";
  });

  it("SSO: shows a classified error when the organization has no connection", async () => {
    sso.enabled = true;
    sso.signInWithSso.mockRejectedValue(new Error("no_sso_connection"));
    render(<AuthDialog open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(t("auth.dialog.ssoDomain")), { target: { value: "acme.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: t("auth.dialog.ssoContinue") }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(t("auth.error.ssoNoConnection"));
    expect(screen.getByRole("button", { name: t("auth.dialog.ssoContinue") }).hasAttribute("disabled")).toBe(false);
  });

  it("follows the active locale (Hebrew)", async () => {
    const he = await loadLocale("he");
    applyLocale("he");
    useAuth.setState({ provider: fakeProvider() });
    render(<AuthDialog open onClose={() => {}} />);
    expect(he["auth.dialog.close"]).toBeTruthy();
    expect(he["auth.dialog.close"]).not.toBe("Close");
    expect(screen.getByRole("button", { name: he["auth.dialog.close"] })).toBeTruthy();
    expect(screen.getByLabelText(he["auth.dialog.email"])).toBeTruthy();
    expect(document.documentElement.dir).toBe("rtl");
  });
});

describe("AuthButton", () => {
  it("renders nothing while the session is still loading", () => {
    useAuth.setState({ status: "loading" });
    const { container } = render(<AuthButton />);
    expect(container.innerHTML).toBe("");
  });

  it("opens the sign-in dialog and says why the user is signed out", () => {
    render(<AuthButton />);
    const pill = screen.getByRole("button", { name: new RegExp(t("auth.signIn")) });
    expect(pill.getAttribute("data-auth-status")).toBe("notConfigured");
    expect(pill.getAttribute("aria-label")).toContain(t("auth.status.notConfigured"));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(pill);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("auth.dialog.close") }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("marks the pill as an error when the provider failed", () => {
    useAuth.setState({ provider: fakeProvider(), status: "error", error: "Failed to fetch" });
    render(<AuthButton />);
    const pill = screen.getByRole("button", { name: new RegExp(t("auth.signIn")) });
    expect(pill.getAttribute("data-auth-status")).toBe("error");
    expect(pill.getAttribute("title")).toContain(t("auth.error.network"));
  });

  it("shows the account initial and signs out from the menu", async () => {
    const provider = fakeProvider();
    useAuth.setState({ provider, status: "authenticated", user: USER });
    render(<AuthButton />);
    const account = screen.getByRole("button", { name: t("auth.accountMenu", { user: "dana@example.com" }) });
    expect(account.textContent).toContain("D");
    expect(account.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(account);
    expect(account.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu");
    expect(menu.textContent).toContain(t("auth.signedInAs"));
    expect(menu.textContent).toContain("dana@example.com");
    fireEvent.click(screen.getByRole("menuitem", { name: t("auth.signOut") }));
    await waitFor(() => expect(useAuth.getState().status).toBe("anonymous"));
    expect(provider.signOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes the account menu when the pointer leaves it", () => {
    useAuth.setState({ status: "authenticated", user: { ...USER, avatarUrl: "https://example.com/a.png" } });
    const { container } = render(<AuthButton />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.com/a.png");
    fireEvent.click(screen.getByRole("button", { name: t("auth.accountMenu", { user: "dana@example.com" }) }));
    fireEvent.mouseLeave(screen.getByRole("menu"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("falls back to the user id when there is no email or name", () => {
    useAuth.setState({ status: "authenticated", user: { id: "id-42", provider: "fake" } });
    render(<AuthButton />);
    const account = screen.getByRole("button", { name: t("auth.accountMenu", { user: "id-42" }) });
    expect(account.textContent).toContain("?");
  });
});
