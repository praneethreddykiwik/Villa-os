import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { apiError, apiOk } from "@/lib/auth/http";

/**
 * Session introspection and sign-out.
 *
 * Signing IN no longer happens here. Credentials go directly to Supabase Auth
 * from the browser, which sets an httpOnly session cookie. This app never sees,
 * stores or hashes a password — which removes an entire class of risk, and means
 * disabling someone in Supabase disables them everywhere immediately.
 */
export async function GET() {
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
  const res = apiOk({ signedOut: true });
  const ref = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").match(/https:\/\/([^.]+)\./)?.[1];
  for (const name of [`sb-${ref}-auth-token`, `sb-${ref}-auth-token.0`, `sb-${ref}-auth-token.1`, "ops_session"]) {
    res.cookies.set(name, "", { httpOnly: true, path: "/", maxAge: 0 });
  }
  return res;
}
