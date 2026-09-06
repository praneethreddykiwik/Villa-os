import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * SECURITY MIDDLEWARE
 *
 * Two jobs, on every request:
 *
 *  1. Set the response headers that remove whole vulnerability classes —
 *     CSP, HSTS, nosniff, framing, referrer and permissions policy.
 *  2. Fail closed on authentication. Anything not explicitly public requires a
 *     session cookie. Routes still perform their own permission checks; this is
 *     the outer fence, not the only one.
 *
 * The CSP uses a per-request nonce with `strict-dynamic` rather than
 * `unsafe-inline`, so an injected <script> without the nonce does not execute
 * even if markup escaping fails somewhere.
 */

/** Reachable without a session. Everything else is denied by default. */
const PUBLIC_PATHS = [
  "/signin",           // sign-in surface — its own layout, no app navigation
  // "/setup" was here so it would work when auth itself is misconfigured. The
  // cost was an anonymous inventory of exactly which secrets are unset — which
  // is a target list, and it announced that the WhatsApp webhook signature was
  // unverifiable. An operator who cannot sign in can read the same information
  // from .env.local on the host; a stranger should not read it over HTTP.
];

/** Authenticate by their own mechanism (signature / shared secret), not a session. */
const SELF_AUTHENTICATING = [
  "/api/webhooks/",        // HMAC-verified (WhatsApp) or shared-secret (n8n)
  // Listed explicitly even though the prefix above already matches it: this
  // array is the inventory of everything the session gate does not cover, and
  // an entry that only exists implicitly is one nobody audits. It authenticates
  // with N8N_WEBHOOK_SECRET, constant-time compared, failing closed when unset.
  "/api/webhooks/n8n",
  // Voice-agent execution updates. Shared secret in x-voice-secret, compared
  // constant-time against VOICE_WEBHOOK_SECRET, failing closed when unset.
  "/api/webhooks/bolna",
  "/api/ops/session",      // the sign-in endpoint itself
  "/api/publish/tick",     // worker secret, constant-time compared
  "/api/ops/followups",    // worker secret or session, checked in-route
  "/auth/callback",        // OAuth / magic-link code exchange, single-use code
];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  if (SELF_AUTHENTICATING.some((p) => pathname.startsWith(p))) return true;
  // Next internals and static assets.
  return (
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/renders/") ||
    pathname.startsWith("/samples/")
  );
}

function hasSessionCookie(req: NextRequest): boolean {
  // Supabase stores its session in cookies prefixed `sb-<ref>-auth-token`.
  // Presence is a cheap gate only — the value is verified server-side by
  // getSession(), which re-validates the JWT with Supabase.
  return req.cookies.getAll().some((c) => /^sb-.*-auth-token/.test(c.name) && c.value.length > 20);
}

function securityHeaders(nonce: string, isDev: boolean): Record<string, string> {
  const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabaseWs = supabase.replace(/^https:/, "wss:");

  const csp = [
    "default-src 'self'",
    // strict-dynamic: only scripts we nonce can run, and anything they load.
    // Dev additionally needs eval for React Fast Refresh; production never does.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // Tailwind injects a style element; styles cannot execute code, so this is
    // a far smaller exposure than inline script would be.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self' data:",
    // LLM and Graph calls are made server-side, never from the page, so the
    // browser needs no egress to those hosts and listing them only widens the
    // policy for an injected script.
    `connect-src 'self' ${supabase} ${supabaseWs}`.trim(),
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

  return {
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(self), geolocation=(self), payment=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    ...(isDev ? {} : { "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload" }),
  };
}

/**
 * Refresh the Supabase session and carry the rotated cookies onto the response.
 *
 * Why this has to happen HERE and nowhere else: the access token lives about an
 * hour, and rotating it means writing a new cookie. Server Components cannot set
 * cookies — `serverClient()` in src/lib/supabase/client.ts even swallows the
 * attempt with a "read-only rendering context" catch — so although
 * `resolveSession()` calls getUser() on every render and Supabase hands back a
 * fresh token, that token was thrown away every single time. An hour after
 * signing in, the cookie held a dead access token and the operator was bounced
 * to /signin. Middleware is the one place in the request path that can both read
 * the old cookie and write the new one.
 *
 * The returned response is the one that must be sent: it carries the rotated
 * cookies. Building a different NextResponse after calling this discards them
 * and reintroduces the logout.
 */
async function withRefreshedSession(
  req: NextRequest,
  res: NextResponse,
): Promise<{ res: NextResponse; signedIn: boolean }> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return { res, signedIn: false };
  }

  let out = res;
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (list) => {
          for (const c of list) out.cookies.set(c.name, c.value, { ...c.options, httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict" });
        },
      },
    },
  );

  try {
    // getUser() re-validates with Supabase and triggers the refresh when the
    // access token is stale. getSession() would trust the cookie and never
    // rotate anything.
    const { data, error } = await supabase.auth.getUser();
    if (error) {
      return { res: out, signedIn: false };
    }
    return { res: out, signedIn: Boolean(data?.user) };
  } catch (err: any) {
    // An explicit auth error (e.g. invalid/expired refresh token) means unauthenticated
    if (err?.status === 400 || err?.code === "refresh_token_not_found" || err?.__isAuthError) {
      return { res: out, signedIn: false };
    }
    // A genuine Supabase network failure must not lock everyone out; fall back to cookie presence
    return { res: out, signedIn: hasSessionCookie(req) };
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isDev = process.env.NODE_ENV !== "production";
  const nonce = crypto.randomUUID().replace(/-/g, "");

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", securityHeaders(nonce, isDev)["Content-Security-Policy"]);
  // Layouts cannot read the pathname directly; publish it so the page guard can.
  requestHeaders.set("x-pathname", pathname);

  // Large multipart video uploads stream directly to the route handler, which enforces
  // its own requirePermission("marketing.publish") session check.
  if (pathname === "/api/automation/post-video" || pathname === "/api/automation/v2/post-video") {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  const base = NextResponse.next({ request: { headers: requestHeaders } });
  const publicPath = isPublic(pathname);
  const { res: refreshed, signedIn } = publicPath
    ? { res: base, signedIn: false }
    : await withRefreshedSession(req, base);

  if (!publicPath) {
    if (!signedIn) {
      if (pathname.startsWith("/api/")) {
        const res = NextResponse.json({ ok: false, error: "Sign in to continue." }, { status: 401 });
        for (const [k, v] of Object.entries(securityHeaders(nonce, isDev))) res.headers.set(k, v);
        return res;
      }
      const url = req.nextUrl.clone();
      url.pathname = "/signin";
      url.searchParams.set("next", pathname);
      const res = NextResponse.redirect(url);
      for (const [k, v] of Object.entries(securityHeaders(nonce, isDev))) res.headers.set(k, v);
      return res;
    }
  }

  for (const [k, v] of Object.entries(securityHeaders(nonce, isDev))) refreshed.headers.set(k, v);
  return refreshed;
}

export const config = {
  // Everything except static assets and large multipart video streaming routes.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/automation/post-video|api/automation/v2/post-video).*)"],
};
