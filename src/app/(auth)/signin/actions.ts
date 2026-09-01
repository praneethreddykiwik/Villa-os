"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createServerClient } from "@supabase/ssr";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { clientKey, rateLimit, resetLimit } from "@/lib/ops/ratelimit";

/**
 * AUTHENTICATION ACTIONS
 *
 * These run on the server, not in the browser. Three things follow from that,
 * and all three are the reason for the change:
 *
 *  1. The sign-in attempt passes through this application's rate limiter. When
 *     the browser called Supabase directly, every throttle in this codebase was
 *     bypassed and the only thing standing between a password list and an
 *     account was Supabase's own generic limit.
 *  2. The Supabase client stays out of the browser bundle. That is roughly
 *     seventy kilobytes of PostgREST, Realtime and Storage code removed from
 *     the one page where nothing is cached and someone is waiting to get in.
 *  3. The form works with JavaScript disabled or still loading, because a plain
 *     form POST is the fallback rather than a broken button.
 */

export interface AuthState {
  error?: string;
  notice?: string;
}

/** Same sentence for every failure, so a probe cannot learn which addresses exist. */
const GENERIC = "Incorrect email or password.";
const LINK_SENT = "If that address has an account, a sign-in link is on its way. It expires in an hour.";

async function serverClient() {
  const store = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (list) => {
          for (const c of list) store.set(c.name, c.value, c.options);
        },
      },
    },
  );
}

/** Only ever an internal path. "//evil.example" is a URL, not a path. */
function safeNext(value: FormDataEntryValue | null): string {
  const raw = typeof value === "string" ? value : "";
  return raw.startsWith("/") && !raw.startsWith("//") ? raw : "/ops";
}

async function requestIp(): Promise<string> {
  const h = await headers();
  return clientKey(new Request("http://local", { headers: h }));
}

/**
 * Two buckets with different shapes, on purpose.
 *
 * The per-account bucket is tight, because eight wrong passwords for one
 * address is already an attack. The per-source bucket is loose, because a whole
 * office behind one office router shares a single address, and a tight limit
 * there locks out everybody to slow down one person.
 */
async function throttle(email: string): Promise<string | null> {
  const ip = await requestIp();
  const bySource = rateLimit(`signin:src:${ip}`, { max: 60, windowSeconds: 300, lockoutSeconds: 300 });
  if (!bySource.allowed) {
    return `Too many attempts from this network. Try again in ${bySource.retryAfterSeconds ?? 300} seconds.`;
  }
  const byAccount = rateLimit(`signin:acct:${email}`, { max: 8, windowSeconds: 300, lockoutSeconds: 900 });
  if (!byAccount.allowed) {
    return `Too many attempts for this account. Try again in ${byAccount.retryAfterSeconds ?? 900} seconds.`;
  }
  return null;
}

export async function signInWithPassword(_prev: AuthState, form: FormData): Promise<AuthState> {
  if (!isSupabaseConfigured()) return { error: "Sign-in is not configured on this deployment." };

  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  const next = safeNext(form.get("next"));
  if (!email || !password) return { error: GENERIC };

  const throttled = await throttle(email);
  if (throttled) return { error: throttled };

  const sb = await serverClient();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error || !data.session) return { error: GENERIC };

  // A correct password clears the counter, so an honest typo streak does not
  // leave someone locked out after they finally get it right.
  resetLimit(`signin:acct:${email}`);

  // Redirect throws, so it must sit outside the try/catch above rather than be
  // swallowed as a failure.
  redirect(data.user.user_metadata?.must_change_password === true ? "/signin" : next);
}

export async function sendMagicLink(_prev: AuthState, form: FormData): Promise<AuthState> {
  if (!isSupabaseConfigured()) return { error: "Sign-in is not configured on this deployment." };

  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const next = safeNext(form.get("next"));
  if (!email) return { notice: LINK_SENT };

  const throttled = await throttle(email);
  if (throttled) return { error: throttled };

  const h = await headers();
  const origin = h.get("origin") ?? `https://${h.get("host") ?? ""}`;

  const sb = await serverClient();
  await sb.auth.signInWithOtp({
    email,
    options: {
      // Without this, anyone who can type an address into the box gets an
      // account created for them.
      shouldCreateUser: false,
      emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });

  // The same confirmation whether or not the address exists, for the same
  // reason the password error is generic.
  return { notice: LINK_SENT };
}

export async function rotatePassword(_prev: AuthState, form: FormData): Promise<AuthState> {
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm") ?? "");
  const next = safeNext(form.get("next"));

  if (password !== confirm) return { error: "The two passwords do not match." };
  if (password.length < 12) {
    return { error: "Use at least 12 characters. Length protects you far more than symbols do." };
  }

  const sb = await serverClient();
  const { error } = await sb.auth.updateUser({
    password,
    data: { must_change_password: false },
  });
  if (error) return { error: error.message };

  redirect(next);
}

export async function signOut(): Promise<void> {
  if (isSupabaseConfigured()) {
    const sb = await serverClient();
    await sb.auth.signOut();
  }
  redirect("/signin");
}

export async function startGoogle(_prev: AuthState, form: FormData): Promise<AuthState> {
  if (!isSupabaseConfigured()) return { error: "Sign-in is not configured on this deployment." };

  const next = safeNext(form.get("next"));
  const h = await headers();
  const origin = h.get("origin") ?? `https://${h.get("host") ?? ""}`;

  const sb = await serverClient();
  const { data, error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}` },
  });
  if (error || !data.url) return { error: "Google sign-in is unavailable right now." };

  redirect(data.url);
}
