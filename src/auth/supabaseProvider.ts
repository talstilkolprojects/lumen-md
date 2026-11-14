import type { AuthProvider, User } from "./types";

/**
 * Supabase adapter — only initialized when both `VITE_SUPABASE_URL` and
 * `VITE_SUPABASE_ANON_KEY` are present. The Supabase JS SDK is loaded via
 * dynamic import so a build without it never pulls the dependency.
 *
 * To enable, install `@supabase/supabase-js` and set the env vars. The
 * provider then handles email/password and OAuth redirect flows for Google
 * and GitHub. Sessions are kept in localStorage by Supabase itself, so
 * `loadSession` reads them on subsequent loads without a network round-trip.
 */

interface SupabaseEnv {
  url: string;
  anonKey: string;
}

function readEnv(): SupabaseEnv | null {
  try {
    // One name at a time: a whole import.meta.env read inlines every VITE_* value.
    const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
    if (!url || !anonKey) return null;
    return { url, anonKey };
  } catch {
    return null;
  }
}

interface SupabaseSessionUser {
  id: string;
  email?: string | null;
  user_metadata?: { name?: string; full_name?: string; avatar_url?: string };
}

function shape(u: SupabaseSessionUser | null | undefined): User | null {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email ?? undefined,
    name: u.user_metadata?.name ?? u.user_metadata?.full_name,
    avatarUrl: u.user_metadata?.avatar_url,
    provider: "supabase",
  };
}

/** Returns a Supabase-backed AuthProvider, or null when env vars are missing. */
export async function createSupabaseProvider(): Promise<AuthProvider | null> {
  const env = readEnv();
  if (!env) return null;
  // The dynamic import is wrapped with `@vite-ignore` so the bundler does not
  // try to resolve the package at build time when it isn't installed. The
  // package is optional — Lumen ships without it by default.
  type SupabaseModule = {
    createClient: (
      url: string,
      key: string,
      opts?: { auth?: { persistSession?: boolean; autoRefreshToken?: boolean; detectSessionInUrl?: boolean } },
    ) => {
      auth: {
        getSession: () => Promise<{
          data: { session: { user: SupabaseSessionUser; access_token?: string } | null };
        }>;
        signInWithPassword: (a: { email: string; password: string }) => Promise<{
          data: { user: SupabaseSessionUser | null };
          error: { message: string } | null;
        }>;
        signUp: (a: { email: string; password: string }) => Promise<{
          data: { user: SupabaseSessionUser | null };
          error: { message: string } | null;
        }>;
        signInWithOAuth: (a: {
          provider: "google" | "github";
          options?: { redirectTo?: string };
        }) => Promise<{ error: { message: string } | null }>;
        signOut: () => Promise<{ error: { message: string } | null }>;
      };
    };
  };
  // The package name is hidden behind a variable so TypeScript doesn't try to
  // resolve types and the bundler skips static analysis of the import path.
  const pkg = "@supabase/supabase-js";
  let mod: SupabaseModule;
  try {
    mod = (await import(/* @vite-ignore */ pkg)) as unknown as SupabaseModule;
  } catch {
    // Package not installed — the local provider will be used instead.
    return null;
  }
  const client = mod.createClient(env.url, env.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  return {
    name: "supabase",
    async loadSession() {
      const { data } = await client.auth.getSession();
      return shape(data.session?.user ?? null);
    },
    async signInWithPassword(email, password) {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
      const u = shape(data.user);
      if (!u) throw new Error("Sign in returned no user");
      return u;
    },
    async signUpWithPassword(email, password) {
      const { data, error } = await client.auth.signUp({ email, password });
      if (error) throw new Error(error.message);
      const u = shape(data.user);
      if (!u) throw new Error("Sign up returned no user");
      return u;
    },
    async signInWithProvider(provider) {
      const { error } = await client.auth.signInWithOAuth({
        provider,
        options: { redirectTo: window.location.origin },
      });
      if (error) throw new Error(error.message);
      // OAuth redirects the page; resolve with a stub so callers don't hang.
      return { id: "oauth-redirect", provider: "supabase" };
    },
    async signOut() {
      await client.auth.signOut();
    },
    async getAccessToken() {
      const { data } = await client.auth.getSession();
      return data.session?.access_token ?? null;
    },
  };
}
