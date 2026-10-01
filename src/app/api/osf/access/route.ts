import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { guard } from "@/lib/auth/guard";
import { actorLabel, getSession } from "@/lib/auth/session";
import { audit, liveMatrix, setRolePermission } from "@/lib/osf/rbac";
import { isProtectedRole } from "@/lib/osf/access-areas";

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
 *  - Editing a protected role. super_admin and owner are the way back in. Strip
 *    their team permissions and nobody can reach this screen again without a
 *    database console.
 *  - Removing the last grant of `team:write`. Same outcome by a different
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
  const permission = typeof body.permission === "string" ? body.permission.trim() : "";
  const allowed = body.allowed === true;

  if (!role || !permission) {
    return NextResponse.json({ ok: false, error: "Name a role and a capability." }, { status: 400 });
  }

  if (isProtectedRole(role)) {
    return NextResponse.json(
      {
        ok: false,
        error: `${role} always has full access — it is the account that can repair the others. Change a different role.`,
      },
      { status: 400 },
    );
  }

  const matrix = await liveMatrix();

  // The catalogue is the list of capabilities that exist. Anything else is a
  // typo or a probe, and upserting it would put a row nothing ever reads into
  // the table that decides access.
  if (!matrix.permissions.some((p) => p.key === permission)) {
    return NextResponse.json({ ok: false, error: "That capability does not exist." }, { status: 400 });
  }

  if (!allowed && permission === "team:write") {
    const holders = Object.entries(matrix.byRole)
      .filter(([r, keys]) => keys.includes("team:write") && !isProtectedRole(r))
      .map(([r]) => r);
    if (holders.length <= 1 && holders[0] === role) {
      return NextResponse.json(
        {
          ok: false,
          error: "That is the last role that can manage the team. Give it to another role first.",
        },
        { status: 400 },
      );
    }
  }

  const result = await setRolePermission(role, permission, allowed);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: "That change could not be saved." }, { status: 500 });
  }

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
  return NextResponse.json({ ok: true, role, permission, allowed });
}
