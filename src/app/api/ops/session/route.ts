import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { cacheKeyFromCookies, clearSessionCache, getSession } from "@/lib/auth/session";
import { apiError, apiOk } from "@/lib/auth/http";
import { clientKey, rateLimit } from "@/lib/ops/ratelimit";

/**
 * Session introspection and sign-out.
 *
 * Signing IN no longer happens here. Credentials go directly to Supabase Auth
 * from the browser, which sets an httpOnly session cookie. This app never sees,
 * stores or hashes a password — which removes an entire class of risk, and means
 * disabling someone in Supabase disables them everywhere immediately.
 */

/**
 * Rate limiting uses the shared limiter, not a local Map.
 *
 * The previous version kept its own `Map<string, …>` keyed on the raw
 * `x-forwarded-for` header. That header is written by the caller, so the key
 * was attacker-chosen and the map had no bound: a flood of made-up values grew
 * it until the instance ran out of memory, and rotating the value walked
 * straight past the limit it was supposed to enforce.
 *
 * `clientKey()` reads the trusted proxy hop instead of the leftmost one and
 * bounds the key to address characters, and `rateLimit()` evicts rotated keys
 * and keeps active lockouts under load. Both properties are pinned by
 * tests/security.test.ts — this route simply had its own copy that the tests
 * never saw.
 */

export async function GET(req: Request) {
  const limit = rateLimit(`ops-session:${clientKey(req)}`, { max: 5, windowSeconds: 60, lockoutSeconds: 300 });
  if (!limit.allowed) {
    return NextResponse.json(
      { ok: false, error: `Too many requests. Retry in ${limit.retryAfterSeconds ?? 60}s.` },
      { status: 429 },
    );
  }
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });
    return apiOk({
      session: {
        userId: session.userId,
        email: session.email,
        fullName: session.fullName,
        orgId: session.orgId,
        roles: session.roles,
      },
      permissions: [...session.permissions],
    });
  } catch (e) {
    return apiError(e);
  }
}

/**
 * Sign out. Clearing the cookie is done by the Supabase client in the browser;
 * this endpoint additionally expires it server-side so a stale cookie left by a
 * failed client-side signOut cannot be replayed.
 */
export async function DELETE() {
  // The session-cache module documents "sign-out calls clearSessionCache() for
  // its own token". That was true of the server action in (auth)/signin only —
  // this endpoint, which is the sign-out the client calls, dropped the cookie
  // and left the resolved entry warm for the rest of its 30s TTL. Anyone
  // holding a copy of the token (a shared machine, a proxy log) kept the old
  // answer for that window. Making the statement true costs three lines.
  const key = cacheKeyFromCookies((await cookies()).getAll().map((c) => ({ name: c.name, value: c.value })));
  if (key) clearSessionCache(key);

  const res = apiOk({ signedOut: true });
  const ref = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").match(/https:\/\/([^.]+)\./)?.[1];
  for (const name of [`sb-${ref}-auth-token`, `sb-${ref}-auth-token.0`, `sb-${ref}-auth-token.1`, "ops_session"]) {
    res.cookies.set(name, "", { httpOnly: true, path: "/", maxAge: 0, sameSite: "strict", secure: process.env.NODE_ENV === "production" });
  }
  return res;
}
