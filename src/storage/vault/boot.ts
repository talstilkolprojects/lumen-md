/**
 * Opening the vault at start-up (plan 4.2). Until the stored location is
 * known the vault is closed, so nothing is read from or written to the wrong
 * store. The location code is a lazy chunk; if it can't load (offline right
 * after an update), the vault would stay closed with no way out. Here it is
 * retried when the browser comes back online, and a bar says what happened
 * with a "Try again" button (a second failure reloads the page).
 */
import { t } from "../../i18n";
import { log } from "../../lib/logger";

export interface VaultBootDeps {
  /** Load the location code and restore the stored location. */
  load: () => Promise<unknown>;
  /** Reload the page (the last resort: a fresh copy of the app). */
  reload?: () => void;
}

const BAR_ID = "lumen-vault-boot-failed";

/** Start opening the vault; resolves when the first attempt settles (never rejects). */
export function openVaultAtBoot({ load, reload = () => location.reload() }: VaultBootDeps): Promise<void> {
  return load().then(
    () => undefined,
    (err: unknown) => {
      log.warn("vault location unavailable; retrying", err);
      recoverLater(load, reload);
    },
  );
}

function recoverLater(load: () => Promise<unknown>, reload: () => void): void {
  let settled = false;
  const done = () => {
    settled = true;
    window.removeEventListener("online", onOnline);
    document.getElementById(BAR_ID)?.remove();
  };
  const onOnline = () => {
    if (!settled) void load().then(done, (err: unknown) => log.warn("vault location still unavailable", err));
  };
  window.addEventListener("online", onOnline);
  // The bar goes up once the page is there (after the first render).
  const show = () => {
    if (settled || document.getElementById(BAR_ID)) return;
    const bar = document.createElement("div");
    bar.id = BAR_ID;
    bar.setAttribute("role", "alert");
    bar.style.cssText =
      "position:fixed;inset-block-start:0;inset-inline:0;z-index:10002;display:flex;gap:12px;align-items:center;justify-content:center;padding-block:8px;padding-inline:16px;background:hsl(var(--bg-muted,0 0% 15%));color:hsl(var(--fg,0 0% 95%));border-block-end:1px solid hsl(var(--border,0 0% 30%));font:13px/1.4 system-ui,sans-serif";
    const text = document.createElement("span");
    text.textContent = t("vault.boot.failed");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = t("vault.boot.retry");
    button.style.cssText = "padding-block:4px;padding-inline:12px;border:1px solid currentColor;border-radius:6px;background:none;color:inherit;font:inherit;cursor:pointer";
    button.onclick = () => {
      button.disabled = true;
      load().then(done, reload);
    };
    bar.append(text, button);
    document.body.append(bar);
  };
  setTimeout(show, 0);
}
