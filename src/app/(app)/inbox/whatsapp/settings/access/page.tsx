import { redirect } from "next/navigation";

/**
 * Access management now lives at /ops/admin.
 *
 * This screen used to render villa_role_permissions: fifteen roles under a
 * second naming scheme (leads:read rather than sales.read), described in its
 * own comment as "what each role actually has". That was true of the
 * villa_can() checks inside Postgres and untrue of this application, which
 * resolves every session's permissions from user_roles -> roles ->
 * role_permissions and consults nothing else when it decides whether to serve
 * a page or answer an endpoint.
 *
 * Two access screens disagreeing about who can do what is worse than one, and
 * the one that was easier to find was the one that changed nothing. The route
 * is kept as a redirect so existing links and bookmarks still arrive somewhere
 * correct.
 */
export const dynamic = "force-dynamic";

export default function AccessPage() {
  redirect("/ops/admin");
}
