import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { isSupabaseConfigured } from "@/lib/supabase/client";

/**
 * Completes a magic-link or OAuth sign-in.
 *
 * Supabase sends the browser back here with a single-use `code`. Exchanging it
 * server-side is what writes the session cookie with HttpOnly set — doing the
 * exchange in the browser would leave the refresh token readable by any script
 * on the page.
 *
 * Nothing here grants access on its own. The exchange only proves the credential;
 * whether the resulting user has a profile and any permissions is decided by
 * resolveSession() on the next request, so an unknown Google account arrives
 * signed in and still sees nothing.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const raw = url.searchParams.get("next") ?? "/ops";

  // Never redirect off-site. "//evil.example" is a protocol-relative URL, so
  // checking only for a leading slash is not enough.
  const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/ops";

  const fail = (reason: string) =>
    NextResponse.redirect(new URL(`/signin?error=${encodeURIComponent(reason)}`, url.origin));

  if (!isSupabaseConfigured()) return fail("auth-not-configured");
  if (!code) return fail("link-invalid");

  const store = await cookies();
  const sb = createServerClient(
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

  const { error } = await sb.auth.exchangeCodeForSession(code);
  // A used, expired or forged code all land here, and all get the same message.
  if (error) return fail("link-expired");

  return NextResponse.redirect(new URL(next, url.origin));
}
