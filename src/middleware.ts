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
  // The outbound call-queue heartbeat. Constant-time CRON_SECRET, failing
  // closed when unset. Matched as a prefix like the rest of this list, which
  // deliberately does NOT open /api/voice/queue — loading the queue rings real
  // phones and stays behind the session gate.
  "/api/voice/queue/run",
  "/api/ops/followups",    // worker secret or session, checked in-route
  "/auth/callback",        // OAuth / magic-link code exchange, single-use code
];

/**
 * Ported villa-os-f webhook endpoints. EXACT matches, never prefixes.
 *
 * Meta and the Evolution server POST these with no cookie and no way to supply
 * one, and each verifies its own caller and fails closed when unconfigured:
 * /api/osf/whatsapp and /api/osf/instagram check Meta's HMAC signature,
 * /api/osf/evolution a shared token, /api/osf/cron/* a constant-time
 * CRON_SECRET. Exact matching matters — /api/osf/whatsapp/test-voice is an
 * operator tool that burns transcription credit and must stay behind the gate.
 */
const OSF_WEBHOOKS_EXACT = [
  "/api/osf/whatsapp",
  "/api/osf/instagram",
  "/api/osf/messenger",
  "/api/osf/evolution",
];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  if (OSF_WEBHOOKS_EXACT.includes(pathname)) return true;
  if (pathname.startsWith("/api/osf/cron/")) return true;
  if (SELF_AUTHENTICATING.some((p) => pathname.startsWith(p))) return true;
  // Next internals and static assets.
  return (
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    // The browser asks for these before anyone has signed in — they are drawn
    // on the tab of the sign-in page itself — and they carry no data. Gating
    // them just meant the product had no icon until you were already inside it.
    pathname === "/icon.svg" ||
    pathname === "/apple-icon.png" ||
    pathname.startsWith("/brand/") ||
    // The client's own customer-facing marketing assets — brochures, the
    // sanctioned layout, the villa renders. WhatsApp fetches these itself, with
    // no cookie and no way to supply one, so a gated URL reaches Meta as a
    // redirect to the sign-in page and the customer receives nothing. Only what
    // is marked shareable in villa_assets lives in this folder; anything
    // internal (the sales presentation) stays at the public root and stays
    // behind the session gate.
    pathname.startsWith("/brochures/") ||
    pathname.startsWith("/renders/") ||
    pathname.startsWith("/samples/") ||
    // Showcase media only — never the /showcase page itself, which stays gated.
    // These are the client's own published marketing renders, and routing every
    // one of them through the session check turned a missing cookie into broken
    // images and put a middleware pass in front of each file request.
    (pathname.startsWith("/showcase/") && /\.(webp|avif|jpg|jpeg|png|svg|json|mp4)$/i.test(pathname))
  );
}

function hasSessionCookie(req: NextRequest): boolean {
  // Supabase stores its session in cookies prefixed `sb-<ref>-auth-token`.
  // Presence is a cheap gate only — the value is verified server-side by
  // getSession(), which re-validates the JWT with Supabase.
  return req.cookies.getAll().some((c) => /^sb-.*-auth-token/.test(c.name) && c.value.length > 20);
}

/**
 * Whether this request actually arrived over TLS.
 *
 * `upgrade-insecure-requests` and HSTS are correct on a real HTTPS deployment
 * and actively harmful on a plain-http origin: the browser rewrites every
 * same-origin request to https://, so on a locally served production build the
 * server actions and RSC prefetches fail with ERR_SSL_PROTOCOL_ERROR and the
 * user sees "Failed to fetch" on sign-in. NODE_ENV cannot tell us this —
 * `npm start` on localhost is production. The scheme can. Behind a proxy the
 * socket is plain http, so the forwarded header is what carries the truth.
 */
function isSecureRequest(req: NextRequest): boolean {
  const forwarded = req.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]!.trim() === "https";
  return req.nextUrl.protocol === "https:";
}

function securityHeaders(nonce: string, isDev: boolean, secure: boolean): Record<string, string> {
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
    ...(!isDev && secure ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  return {
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(self), geolocation=(self), payment=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    ...(!isDev && secure
      ? { "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload" }
      : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Auth verdict cache                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `getUser()` is a network round-trip to Supabase — measured at ~160ms — and it
 * ran on EVERY request that was not explicitly public. That included every RSC
 * prefetch, and the WhatsApp workspace renders around fifty links, so simply
 * opening it queued dozens of 160ms auth calls that starved the navigation the
 * operator had actually clicked. The screen felt broken; nothing was broken
 * except that the outer fence was being rebuilt from scratch fifty times.
 *
 * So the verdict is cached per worker, keyed by the auth cookie itself, for a
 * few seconds. Three things keep that honest:
 *
 *  - The key IS the cookie, so a different (or forged, or rotated) cookie is a
 *    different key and gets a real verification. One user's verdict can never
 *    be served to another.
 *  - This is the coarse gate, not the security boundary. Every page resolves
 *    the session again through `resolveSession()` and every route calls
 *    `guard()`/`requirePermission()`; both verify with Supabase. A cookie that
 *    slips past this cache still cannot read anything.
 *  - The TTL is deliberately shorter than the session cache's 30s, and token
 *    rotation still happens on the first request after it lapses — well inside
 *    the access token's ~1 hour life.
 *
 * A sign-out or a token rotation writes new cookies, which is a new key, so
 * neither waits for the TTL.
 */
const AUTH_TTL_MS = 10_000;
/** Bounded so a long-lived worker cannot accumulate entries without limit. */
const AUTH_CACHE_MAX = 500;

const authVerdicts = new Map<string, { signedIn: boolean; expiresAt: number }>();

/**
 * Identity of the request's Supabase session, or null when there is no auth
 * cookie at all — an anonymous request, which costs nothing and is not cached.
 *
 * Supabase splits a large cookie into `.0`, `.1`, … chunks. Every chunk is
 * folded in, sorted by name so chunk order cannot vary between requests, and
 * prefixed with its own name so two users' chunks cannot concatenate into the
 * same string.
 */
function authKey(req: NextRequest): string | null {
  const parts = req.cookies
    .getAll()
    .filter((c) => c.name.startsWith("sb-") && c.name.includes("-auth-token"))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((c) => `${c.name}=${c.value}`);
  return parts.length ? parts.join("&") : null;
}

function cachedVerdict(key: string, now: number): boolean | null {
  const hit = authVerdicts.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now) {
    authVerdicts.delete(key);
    return null;
  }
  return hit.signedIn;
}

function rememberVerdict(key: string, signedIn: boolean, now: number): void {
  if (authVerdicts.size >= AUTH_CACHE_MAX) {
    for (const [k, v] of authVerdicts) {
      if (v.expiresAt <= now) authVerdicts.delete(k);
    }
    // Still full of live entries: drop the oldest insertion to stay bounded.
    if (authVerdicts.size >= AUTH_CACHE_MAX) {
      const oldest = authVerdicts.keys().next().value;
      if (oldest !== undefined) authVerdicts.delete(oldest);
    }
  }
  authVerdicts.set(key, { signedIn, expiresAt: now + AUTH_TTL_MS });
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
          for (const c of list) out.cookies.set(c.name, c.value, c.options);
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
  const secure = isSecureRequest(req);
  const nonce = crypto.randomUUID().replace(/-/g, "");

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", securityHeaders(nonce, isDev, secure)["Content-Security-Policy"]);
  // Layouts cannot read the pathname directly; publish it so the page guard can.
  requestHeaders.set("x-pathname", pathname);

  // Large multipart video uploads stream directly to the route handler, which enforces
  // its own requirePermission("marketing.publish") session check.
  if (pathname === "/api/automation/post-video" || pathname === "/api/automation/v2/post-video") {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  const base = NextResponse.next({ request: { headers: requestHeaders } });
  const publicPath = isPublic(pathname);

  // A recently verified cookie skips the round-trip. See the note on
  // `authVerdicts` for why that is safe and what still verifies properly.
  const key = publicPath ? null : authKey(req);
  const now = Date.now();
  const cached = key ? cachedVerdict(key, now) : null;

  let refreshed = base;
  let signedIn = false;
  if (!publicPath) {
    if (cached !== null) {
      signedIn = cached;
    } else {
      const result = await withRefreshedSession(req, base);
      refreshed = result.res;
      signedIn = result.signedIn;
      if (key) rememberVerdict(key, signedIn, now);
    }
  }

  if (!publicPath) {
    if (!signedIn) {
      if (pathname.startsWith("/api/")) {
        const res = NextResponse.json({ ok: false, error: "Sign in to continue." }, { status: 401 });
        for (const [k, v] of Object.entries(securityHeaders(nonce, isDev, secure))) res.headers.set(k, v);
        return res;
      }
      const url = req.nextUrl.clone();
      url.pathname = "/signin";
      url.searchParams.set("next", pathname);
      const res = NextResponse.redirect(url);
      for (const [k, v] of Object.entries(securityHeaders(nonce, isDev, secure))) res.headers.set(k, v);
      return res;
    }
  }

  for (const [k, v] of Object.entries(securityHeaders(nonce, isDev, secure))) refreshed.headers.set(k, v);
  return refreshed;
}

/**
 * Everything except static assets and the two large multipart video upload
 * routes.
 *
 * WHY THE TWO UPLOAD ROUTES ARE EXCLUDED. They stream multi-megabyte video
 * bodies, and running them through the middleware's session round-trip on the
 * edge adds latency to every chunk. Both call `requirePermission("marketing.publish")`
 * in-route — `post-video/route.ts:59` and `v2/post-video/route.ts:35` — so they
 * are authenticated, just not double-fenced.
 *
 * WHY EACH EXCLUSION IS ANCHORED WITH `$`. Without the anchor these are prefix
 * matches, so a future route named `post-video-callback` or
 * `post-video/debug` would silently inherit the exclusion and ship with no
 * session gate at all. Nothing in the test suite inspects this matcher, so
 * that would not fail CI — it would just be quietly unauthenticated. The
 * anchor makes the carve-out mean the two paths it names and nothing else.
 */
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/automation/post-video$|api/automation/v2/post-video$).*)",
  ],
};
