import { getSession } from "@/lib/auth/session";
import { OpsHome } from "@/components/ops/home";

export const dynamic = "force-dynamic";

/**
 * The workspace home.
 *
 * There is no signed-out branch here any more. The layout above this page
 * guarantees a session before it renders, and the sign-in form lives in the
 * `(auth)` route group where it does not inherit the navigation sidebar.
 */
export default async function OpsPage() {
  const session = await getSession();
  if (!session) return null; // unreachable: the layout redirects first

  return (
    <OpsHome
      session={{
        name: session.fullName,
        roles: session.roles,
        permissions: [...session.permissions],
      }}
    />
  );
}
