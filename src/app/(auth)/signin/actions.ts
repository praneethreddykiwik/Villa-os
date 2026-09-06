"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createServerClient } from "@supabase/ssr";
import { adminClient, hasServiceRole, isSupabaseConfigured } from "@/lib/supabase/client";
import { readMustChangePassword } from "@/lib/auth/session";
import { logAuthEvent, stampLastLogin } from "@/lib/auth/audit";
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
          for (const c of list) store.set(c.name, c.value, { ...c.options, httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict" });
        },
      },
    },
  );
}

/** Only ever an internal path. "//evil.example" is a URL, not a path. */
function safeNext(value: FormDataEntryValue | null): string {
  const raw = typeof value === "string" ? value : "";
  // "//evil.example" was rejected but "/\evil.example" was not — browsers treat
  // a backslash as a slash when resolving, so it is the same protocol-relative
  // redirect wearing a different hat. Accept a single leading slash followed by
  // something that cannot begin an authority, and nothing else.
  if (!raw.startsWith("/")) return "/ops";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/ops";
  // Reject control characters and whitespace, which browsers strip before parsing.
  if (/[\x00-\x1f\x7f\s]/.test(raw)) return "/ops";
  return raw;
}

async function requestIp(): Promise<string> {
  const h = await headers();
  return clientKey(new Request("http://local", { headers: h }));
}

/**
 * Three buckets with different shapes, on purpose.
 *
 * The tight lock used to hang on the account alone, and that made it a denial
 * of service anybody could aim. Eight wrong passwords against a named staff
 * address — no session, no account, just an address off an email signature —
 * put that person into a fifteen-minute lockout, and eight more every fifteen
 * minutes kept them locked out for as long as the attacker cared to keep
 * typing. The limiter was doing exactly what it was written to do, to whoever
 * the attacker chose.
 *
 * So the tight lock now hangs on the (account, source) pair. That is the pair a
 * guessing run actually occupies: it still stops after eight tries, but it is
 * scoped to the attacker's own network rather than to the victim's account, and
 * a colleague signing in from anywhere else never feels it.
 *
 * The account-wide bucket stays, because the pair bucket on its own would let
 * someone with many source addresses spread a password list thin across them.
 * Two things keep it from becoming the old weapon. It is wide enough that a
 * single source can never reach it — the pair bucket caps that source at eight
 * per lockout first — so tripping it takes coordinated traffic from several
 * networks, which is a real distributed attack. And its lockout is sixty
 * seconds rather than fifteen minutes: it is a ceiling on how fast an account
 * can be guessed at, not a door that can be held shut. Raising `max` until
 * nobody trips it would be the same as deleting it, so the cost is paid in
 * lockout length instead, where the victim's worst case is a minute.
 *
 * The per-source bucket is loose, because a whole office behind one router
 * shares a single address and a tight limit there locks out everybody to slow
 * down one person.
 */
async function throttle(email: string): Promise<{ source: string; error: string | null }> {
  const source = await requestIp();
  const bySource = rateLimit(`signin:src:${source}`, { max: 60, windowSeconds: 300, lockoutSeconds: 300 });
  if (!bySource.allowed) {
    return { source, error: `Too many attempts from this network. Try again in ${bySource.retryAfterSeconds ?? 300} seconds.` };
  }
  const byPair = rateLimit(`signin:pair:${source}:${email}`, { max: 8, windowSeconds: 300, lockoutSeconds: 900 });
  if (!byPair.allowed) {
    return { source, error: `Too many attempts for this account. Try again in ${byPair.retryAfterSeconds ?? 900} seconds.` };
  }
  const byAccount = rateLimit(`signin:acct:${email}`, { max: 40, windowSeconds: 3600, lockoutSeconds: 60 });
  if (!byAccount.allowed) {
    return { source, error: `Too many attempts for this account. Try again in ${byAccount.retryAfterSeconds ?? 60} seconds.` };
  }
  return { source, error: null };
}

export async function signInWithPassword(_prev: AuthState, form: FormData): Promise<AuthState> {
  if (!isSupabaseConfigured()) return { error: "Sign-in is not configured on this deployment." };

  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  const next = safeNext(form.get("next"));
  if (!email || !password) return { error: GENERIC };

  const { source, error: throttled } = await throttle(email);
  if (throttled) {
    logAuthEvent({ method: "password", outcome: "throttled", email, source });
    return { error: throttled };
  }

  const sb = await serverClient();
  let res = await sb.auth.signInWithPassword({ email, password });
  if ((res.error || !res.data.session) && password.trim() !== password) {
    const trimmedRes = await sb.auth.signInWithPassword({ email, password: password.trim() });
    if (!trimmedRes.error && trimmedRes.data.session) {
      res = trimmedRes;
    }
  }
  const { data, error } = res;
  if (error || !data.session) {
    // Outcome only. The provider's reason distinguishes "no such user" from
    // "wrong password", and writing that down rebuilds the enumeration oracle
    // the generic on-screen message closes.
    logAuthEvent({ method: "password", outcome: "failure", email, source });
    return { error: GENERIC };
  }

  logAuthEvent({ method: "password", outcome: "success", email, source });

  // A correct password clears both counters, so an honest typo streak does not
  // leave someone locked out after they finally get it right — and a spraying
  // run aimed at this address leaves no residue that throttles its real owner.
  resetLimit(`signin:pair:${source}:${email}`);
  resetLimit(`signin:acct:${email}`);

  // Must happen before the redirect below, which throws by design: anything
  // placed after it never runs, which is how the column ended up never written.
  await stampLastLogin(data.user.id);

  // Redirect throws, so it must sit outside the try/catch above rather than be
  // swallowed as a failure.
  redirect(readMustChangePassword(data.user) ? "/signin" : next);
}

export async function sendMagicLink(_prev: AuthState, form: FormData): Promise<AuthState> {
  if (!isSupabaseConfigured()) return { error: "Sign-in is not configured on this deployment." };

  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const next = safeNext(form.get("next"));
  if (!email) return { notice: LINK_SENT };

  const { source, error: throttled } = await throttle(email);
  if (throttled) {
    logAuthEvent({ method: "magic_link", outcome: "throttled", email, source });
    return { error: throttled };
  }

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

  // Recorded as a request rather than a sign-in: whether the link is used is
  // decided later, at the callback. The screen still says the same thing
  // whether or not the address exists, for the same reason the password error
  // is generic — the log is where the difference is allowed to be visible, and
  // even there only as "somebody asked for a link to this address".
  logAuthEvent({ method: "magic_link", outcome: "requested", email, source });

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
  const { data, error } = await sb.auth.updateUser({
    password,
    // Clears the legacy copy of the flag. Accounts created before it moved still
    // carry it here and it is still read as a fallback, so leaving it behind
    // would keep an older account bouncing back to this screen forever.
    data: { must_change_password: false },
  });
  if (error) return { error: error.message };

  // The authoritative flag lives in app_metadata precisely because this session
  // cannot write it — so clearing it takes the service role. Report the failure
  // instead of redirecting: the next request would bounce straight back here and
  // the form would look like it silently did nothing.
  if (data.user?.app_metadata?.must_change_password === true) {
    if (!hasServiceRole()) {
      return { error: "Your password was changed, but this deployment cannot lift the password-change requirement. Ask an administrator." };
    }
    const { error: clearError } = await adminClient().auth.admin.updateUserById(data.user.id, {
      app_metadata: { must_change_password: false },
    });
    if (clearError) {
      return { error: "Your password was changed, but the password-change requirement could not be lifted. Ask an administrator." };
    }
  }

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
