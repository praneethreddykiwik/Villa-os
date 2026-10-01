import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getSession, hasPermission } from "@/lib/auth/session";
import { requiredPermissionFor } from "@/lib/auth/page-access";
import { Sidebar } from "@/components/shell";
import { NoAccess } from "@/components/ops/no-access";
import { QuickSettings } from "@/components/quick-settings";
import { readThemeChoice, THEME_COOKIE } from "@/lib/theme";

/**
 * App shell and the single page-level authorization gate.
 *
 * Enforcing here rather than per-page means a newly added screen is protected
 * by default: an unmapped path is denied, so forgetting to add a rule fails
 * closed instead of exposing data.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = (await headers()).get("x-pathname") ?? "/";
  const required = requiredPermissionFor(pathname);
  const session = await getSession();

  if (!session) redirect(`/signin?next=${encodeURIComponent(pathname)}`);

  // A temporary password is a credential an administrator has seen. Enforcing
  // the change here rather than only on the sign-in screen closes the gap where
  // someone signs in with it and then simply navigates somewhere else.
  if (session.mustChangePassword) redirect(`/signin?next=${encodeURIComponent(pathname)}`);

  let allowed = true;
  if (required === null) allowed = false;
  else if (required !== "allow") allowed = hasPermission(session, required);

  // The navigation only offers what this person can actually open, so nobody is
  // invited into a door that is locked.
  const permissions = [...session.permissions];

  // Read here rather than letting the control discover it after hydration, so
  // the lit option is correct in the first paint instead of jumping.
  const initialTheme = readThemeChoice((await cookies()).get(THEME_COOKIE)?.value);

  return (
    <div className="app-ambient flex min-h-screen">
      <div className="app-ambient-glow" aria-hidden="true" />
      <Suspense fallback={<div className="hidden w-[240px] shrink-0 border-r border-ink-800 lg:block" />}>
        <Sidebar
          counts={{}}
          permissions={permissions}
          sessionInfo={{ name: session.fullName, email: session.email, role: session.roles[0] }}
        />
      </Suspense>
      {/* pt-16 below lg clears the fixed drawer opener, which would otherwise
          sit on top of the first heading on every page. */}
      <main className="min-w-0 flex-1 pb-24 pt-16 lg:pt-0">
        {allowed ? children : <NoAccess pathname={pathname} required={required} roles={session.roles} />}
      </main>
      {/* Outside <main> and owned by the layout, so it is reachable on every
          screen and for every role — including the no-access branch above,
          where signing out is the only useful thing left to do. */}
      <QuickSettings
        initialTheme={initialTheme}
        person={{ name: session.fullName, email: session.email, role: session.roles[0] }}
      />
    </div>
  );
}
