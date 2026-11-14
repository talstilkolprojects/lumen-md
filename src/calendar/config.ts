/**
 * Calendar connections (plan W7.20). What is not secret (the CalDAV calendar's
 * URL, the user name, the inbox note) lives in settings storage; the password
 * and the ICS subscription list (a private ICS address is itself a key) live
 * only in the secret store (2.5). Every request goes through the privacy
 * ledger with its own reason.
 */
import { getSecret, setSecret } from "../lib/secretStore";
import { ledgerFetch } from "../ai/privacyLedger";
import { basicAuth } from "./caldav";

export const CALDAV_KEY = "lumen.calendar.caldav";
export const CALDAV_PASSWORD = "lumen.calendar.caldav.password";
export const ICS_SUBSCRIPTIONS = "lumen.calendar.subscriptions";
export const CALDAV_STATE = "lumen.calendar.caldav.state";

export interface CalDavAccount {
  /** The calendar collection (e.g. https://caldav.fastmail.com/dav/calendars/user/me@x/tasks/). */
  url: string;
  user: string;
  /** The note tasks from the server are added to. */
  inbox: string;
}

export interface IcsSubscription {
  id: string;
  name: string;
  url: string;
}

type KV = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const ls = (): KV | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function readAccount(store: KV | null = ls()): CalDavAccount | null {
  try {
    const v = JSON.parse(store?.getItem(CALDAV_KEY) ?? "null") as Partial<CalDavAccount> | null;
    return v && typeof v.url === "string" && typeof v.user === "string" ? { url: v.url, user: v.user, inbox: v.inbox || "Tasks/Calendar.md" } : null;
  } catch {
    return null;
  }
}

/** Saves the account; the password goes to the secret store only, never with the rest. */
export async function saveAccount(account: CalDavAccount, password: string | null, store: KV | null = ls()): Promise<void> {
  const { url, user, inbox } = account;
  store?.setItem(CALDAV_KEY, JSON.stringify({ url, user, inbox }));
  if (password !== null) await setSecret(CALDAV_PASSWORD, password);
}

export async function forgetAccount(store: KV | null = ls()): Promise<void> {
  store?.removeItem(CALDAV_KEY);
  store?.removeItem(CALDAV_STATE);
  await setSecret(CALDAV_PASSWORD, null);
}

export function authorizationFor(account: CalDavAccount): string | undefined {
  const pw = getSecret(CALDAV_PASSWORD);
  return pw ? basicAuth(account.user, pw) : undefined;
}

export function readSubscriptions(): IcsSubscription[] {
  try {
    const v = JSON.parse(getSecret(ICS_SUBSCRIPTIONS) ?? "[]") as IcsSubscription[];
    return Array.isArray(v) ? v.filter((s) => s && typeof s.url === "string") : [];
  } catch {
    return [];
  }
}

export const saveSubscriptions = (subs: readonly IcsSubscription[]): Promise<void> => setSecret(ICS_SUBSCRIPTIONS, subs.length ? JSON.stringify(subs) : null);

/** `webcal://` is https with a calendar app's scheme. */
export const httpUrl = (url: string): string => url.trim().replace(/^webcals?:\/\//i, "https://");

/** The fetch for calendar traffic: recorded in the privacy ledger, allowed because the user set it up. */
export function calendarFetch(reason: "caldav" | "ics"): typeof fetch {
  return ledgerFetch({ force: { category: "third-party", reason: reason === "caldav" ? "CalDAV task sync (your calendar server)" : "Calendar subscription (ICS, read only)" }, consent: true });
}
