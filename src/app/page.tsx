import { redirect } from "next/navigation";
import { getSession, hasPermission } from "@/lib/auth/session";

/**
 * Where signing in lands you.
 *
 * The dashboard, for anyone who can open it. It needs `analytics.view`, so
 * this used to send everybody to /ops instead — which meant an admin's first
 * screen after signing in was a workspace index rather than their business.
 *
 * The fallback still matters: a front-desk or construction account has no
 * `analytics.view`, and redirecting them to a locked door would be a worse
 * first impression than the workspace they can actually use.
 */
export default async function Home() {
  const session = await getSession();
  redirect(hasPermission(session, "analytics.view") ? "/dashboard" : "/ops");
}
