import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { guard } from "@/lib/auth/guard";
import { actorLabel, clearAllSessions, getSession, PERMISSIONS, type Permission } from "@/lib/auth/session";
import { audit } from "@/lib/osf/rbac";
import { accessMatrix, isProtectedRole, setRolePermission } from "@/lib/access/app-rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Granting and revoking one capability for one role.
 *
 * `users.manage`, because this decides what every other account in the company
 * can see. It is the one screen where a wrong click is not a mistake in one
 * record but a standing change to who can read customer data.
 *
 * Two things are refused outright rather than confirmed:
 *
 *  - Editing a protected role. `admin` is the way back in. Strip its ability to
 *    manage people and nobody can reach this screen again without a database
 *    console.
 *  - Removing the last grant of `users.manage`. Same outcome by a different
 *    route: the lock works, and the key is inside.
 */

export async function POST(request: Request) {
  const denied = await guard("users.manage");
  if (denied) return denied;

  let body: { role?: unknown; permission?: unknown; allowed?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Send a JSON object." }, { status: 400 });
  }

  const role = typeof body.role === "string" ? body.role.trim() : "";
  const permissionRaw = typeof body.permission === "string" ? body.permission.trim() : "";
  const allowed = body.allowed === true;

  if (!role || !permissionRaw) {
    return NextResponse.json({ ok: false, error: "Name a role and a capability." }, { status: 400 });
  }

  // The catalogue is the list of capabilities the application understands.
  // Anything else is a typo or a probe, and storing it would put a row nothing
  // ever reads into the table that decides access.
  if (!(PERMISSIONS as readonly string[]).includes(permissionRaw)) {
    return NextResponse.json({ ok: false, error: "That capability does not exist." }, { status: 400 });
  }
  const permission = permissionRaw as Permission;

  if (isProtectedRole(role)) {
    return NextResponse.json(
      {
        ok: false,
        error: `${role} always has full access — it is the account that can repair the others. Change a different role.`,
      },
      { status: 400 },
    );
  }

  const matrix = await accessMatrix();
  if (!matrix.roles.some((r) => r.key === role)) {
    return NextResponse.json({ ok: false, error: "That role does not exist." }, { status: 400 });
  }

  if (!allowed && permission === "users.manage") {
    const holders = Object.entries(matrix.byRole)
      .filter(([key, held]) => held.includes("users.manage") && !isProtectedRole(key))
      .map(([key]) => key);
    if (holders.length <= 1 && holders[0] === role) {
      return NextResponse.json(
        {
          ok: false,
          error: "That is the last role that can manage access. Give it to another role first.",
        },
        { status: 400 },
      );
    }
  }

  const result = await setRolePermission(role, permission, allowed);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: "That change could not be saved." }, { status: 500 });
  }

  /**
   * Sessions cache their resolved permissions for 30 seconds. Without this the
   * change is real in the database and invisible in the application for up to
   * half a minute — which reads as the switch not having worked, and invites a
   * second click. It also matters the other way: a revoked capability should
   * stop working now, not when a cache happens to expire.
   */
  clearAllSessions();

  // Who changed whose access, and when. The one screen that most needs a
  // trail, because its effects are invisible until somebody uses them.
  await audit({
    action: allowed ? "access.granted" : "access.revoked",
    entity: "role_permission",
    entityId: `${role}:${permission}`,
    actorEmail: actorLabel(await getSession()),
    actorType: "human",
    metadata: { role, permission, allowed },
  }).catch(() => {});

  revalidatePath("/ops/admin");
  revalidatePath("/", "layout");
  return NextResponse.json({ ok: true, role, permission, allowed });
}
