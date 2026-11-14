/**
 * The app's per-note Publish / Update / Unpublish for Standard.site (plan
 * W7.19, review 20). Loaded lazily by the commands in commands/domains/export.ts.
 *
 * - One note, the open one, only when the user runs the command: nothing is
 *   picked by default and nothing is published in bulk.
 * - Before any request, a confirmation that says the record is public and
 *   permanent (relays keep copies). Declining sends nothing.
 * - The App Password is asked for one sign-in and never stored; the refresh
 *   token is kept in the secret store so the next action needs no password.
 * - The record is built from the redacted text inside standardSite.ts.
 */
import "./standardSiteStrings";
import { t } from "../i18n";
import { showAiToast } from "../ui/AiToast";
import { REFRESH_SECRET, atprotoFetch, login, noteTitle, publishNote, resume, unpublishNote, DeclinedError, type AtSession } from "./standardSite";
import { explainError } from "../lib/userError";

const ACCOUNT_KEY = "lumen.atproto.account";
const PUBLISHED_KEY = "lumen.atproto.published";

interface Account {
  handle: string;
  siteUrl: string;
  siteName: string;
}

type Published = Record<string, { publishedAt: string; uri: string; url: string }>;

const read = <T,>(k: string, d: T): T => {
  try {
    return (JSON.parse(localStorage.getItem(k) ?? "null") as T) ?? d;
  } catch {
    return d;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* why: storage full or blocked; the next publish asks again */
  }
};

async function account(): Promise<Account | null> {
  const saved = read<Account | null>(ACCOUNT_KEY, null);
  if (saved?.handle && saved.siteUrl && saved.siteName) return saved;
  const { uiPrompt } = await import("../ui/PromptDialog");
  // i18n-allow: the AT Protocol handle syntax, the same in every language
  const handle = (await uiPrompt({ message: t("atproto.handle"), placeholder: "@handle" }))?.trim().replace(/^@/, "");
  if (!handle) return null;
  // i18n-allow: a URL scheme, the same in every language
  const siteUrl = (await uiPrompt({ message: t("atproto.siteUrl"), placeholder: "https://" }))?.trim();
  if (!siteUrl || !/^https:\/\//.test(siteUrl)) return null;
  const siteName = (await uiPrompt({ message: t("atproto.siteName") }))?.trim();
  if (!siteName) return null;
  const a = { handle, siteUrl, siteName };
  write(ACCOUNT_KEY, a);
  return a;
}

let session: AtSession | null = null;

async function signIn(f: typeof fetch, a: Account): Promise<AtSession | null> {
  if (session && session.handle === a.handle) return session;
  const { getSecret, setSecret, initSecretStore } = await import("../lib/secretStore");
  await initSecretStore().catch(() => undefined);
  const refresh = getSecret(REFRESH_SECRET);
  if (refresh) {
    try {
      session = await resume(f, { refreshJwt: refresh });
    } catch (e) {
      if (e instanceof DeclinedError) throw e;
      session = null;
    }
  }
  if (!session) {
    const { uiPrompt } = await import("../ui/PromptDialog");
    const pw = await uiPrompt({ message: t("atproto.password"), password: true });
    if (!pw) return null;
    session = await login(f, { identifier: a.handle, appPassword: pw });
  }
  // Keep only the refresh token; the password is gone with this function.
  await setSecret(REFRESH_SECRET, session.refreshJwt ?? null).catch(() => undefined);
  return session;
}

/** Publish (or update) the open note. `path` is its vault path; `markdown` its text (redacted again inside). */
export async function publishOpenNote(doc: { path: string; markdown: string }): Promise<void> {
  const a = await account();
  if (!a) return;
  const published = read<Published>(PUBLISHED_KEY, {});
  const prev = published[doc.path];
  const title = noteTitle(doc.markdown, doc.path);
  const { uiConfirm } = await import("../ui/PromptDialog");
  // Asked before anything else (the password too); the fetch holds the same answer, so nothing is sent without it.
  const asked = uiConfirm({ title: t("atproto.confirm.title"), message: t(prev ? "atproto.confirm.update" : "atproto.confirm.publish", { title, handle: a.handle }), okLabel: t("atproto.confirm.ok") });
  if (!(await asked)) return;
  const f = await atprotoFetch(() => asked);
  try {
    const s = await signIn(f, a);
    if (!s) return;
    const now = new Date();
    const r = await publishNote(f, s, { site: { url: a.siteUrl, name: a.siteName }, path: doc.path, markdown: doc.markdown, now, ...(prev ? { publishedAt: new Date(prev.publishedAt) } : {}) });
    published[doc.path] = { publishedAt: prev?.publishedAt ?? now.toISOString(), uri: r.document, url: r.url };
    write(PUBLISHED_KEY, published);
    showAiToast(t(prev ? "atproto.updated" : "atproto.done", { url: r.url }), "success");
  } catch (e) {
    if (e instanceof DeclinedError) return;
    session = null;
    showAiToast(t("atproto.failed", { error: explainError(e, "atproto") }), "error");
  }
}

export async function unpublishOpenNote(doc: { path: string; markdown: string }): Promise<void> {
  const published = read<Published>(PUBLISHED_KEY, {});
  const a = read<Account | null>(ACCOUNT_KEY, null);
  if (!published[doc.path] || !a) return showAiToast(t("atproto.notPublished"), "info");
  const { uiConfirm } = await import("../ui/PromptDialog");
  const asked = uiConfirm({ title: t("atproto.unpublish.title"), message: t("atproto.unpublish.confirm", { title: noteTitle(doc.markdown, doc.path), handle: a.handle }), okLabel: t("atproto.unpublish.ok") });
  if (!(await asked)) return;
  const f = await atprotoFetch(() => asked);
  try {
    const s = await signIn(f, a);
    if (!s) return;
    await unpublishNote(f, s, doc.path);
    delete published[doc.path];
    write(PUBLISHED_KEY, published);
    showAiToast(t("atproto.removed"), "success");
  } catch (e) {
    if (e instanceof DeclinedError) return;
    session = null;
    showAiToast(t("atproto.failed", { error: explainError(e, "atproto") }), "error");
  }
}
