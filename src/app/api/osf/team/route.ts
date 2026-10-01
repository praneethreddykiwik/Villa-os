import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { readPost, respond, safePath, type ActionResult } from "@/lib/osf/form-post";
import {
  assignLead,
  createTeamMember,
  provisionAuthUser,
  resetAuthPassword,
  revokeAuthAccess,
  roundRobinAssign,
  setRole,
  toggleActive,
} from "@/lib/osf/team";
import { AccessError, audit, requirePermission, type Member } from "@/lib/osf/rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Team roster writes: add a member, activate/deactivate one, own a lead,
 * and manage sign-in accounts.
 *
 * `assign` takes two sentinels in memberId so the caller never has to hit a
 * different endpoint: "auto" runs round-robin, "none" clears the owner.
 *
 * Authorisation is split by blast radius. Assigning a lead is day-to-day sales
 * work; creating an account or changing someone's role changes what a person
 * can see across the whole system, so those need team:write. Before this route
 * simply required *a* session, which meant any signed-in user could grant
 * themselves a role.
 */
export async function POST(request: Request) {
  const body = await readPost(request);
  const action = body.get("action");
  const redirectTo = safePath(body.get("next"), "/inbox/whatsapp/settings/access");

  const ADMIN_ACTIONS = ["create", "toggle", "role", "provision", "reset-password", "revoke"];
  const required = ADMIN_ACTIONS.includes(action ?? "") ? "team:write" : "leads:assign";

  let actor: Member;
  try {
    actor = await requirePermission(required);
  } catch (error) {
    if (error instanceof AccessError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  let result: ActionResult;

  switch (action) {
    case "create": {
      result = await createTeamMember({
        name: body.get("name") ?? "",
        email: body.get("email") ?? null,
        phone: body.get("phone") ?? null,
        role: body.get("role"),
        department: body.get("department"),
        acceptsLeads: body.bool("acceptsLeads"),
      });
      break;
    }

    case "toggle": {
      const id = body.get("id");
      if (!id) {
        return NextResponse.json({ error: "id is required" }, { status: 400 });
      }
      result = await toggleActive(id);
      break;
    }

    case "assign": {
      const leadId = body.get("leadId");
      if (!leadId) {
        return NextResponse.json({ error: "leadId is required" }, { status: 400 });
      }
      const memberId = body.get("memberId");
      if (memberId === "auto") {
        result = await roundRobinAssign(leadId);
      } else {
        result = await assignLead(leadId, memberId === "none" || !memberId ? null : memberId);
      }
      break;
    }

    /** Change a role, and with it every permission that role carries. */
    case "role": {
      const id = body.get("id");
      const role = body.get("role");
      if (!id || !role) {
        return NextResponse.json({ error: "id and role are required" }, { status: 400 });
      }
      result = await setRole(id, role);
      break;
    }

    /**
     * Create the Supabase Auth account for an existing member.
     * The password is read from the body and passed straight to Supabase; it is
     * never written to the audit row or any log.
     */
    case "provision": {
      const id = body.get("id");
      const password = body.get("password");
      if (!id || !password) {
        return NextResponse.json({ error: "id and password are required" }, { status: 400 });
      }
      const provisioned = await provisionAuthUser(id, password);
      result = provisioned.ok ? { ok: true } : provisioned;
      break;
    }

    case "reset-password": {
      const id = body.get("id");
      const password = body.get("password");
      if (!id || !password) {
        return NextResponse.json({ error: "id and password are required" }, { status: 400 });
      }
      result = await resetAuthPassword(id, password);
      break;
    }

    /** Ends every live session for that person, not just their browser cookie. */
    case "revoke": {
      const id = body.get("id");
      if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
      result = await revokeAuthAccess(id);
      break;
    }

    default:
      return NextResponse.json(
        {
          error:
            "action must be one of create, toggle, assign, role, provision, reset-password, revoke",
        },
        { status: 400 },
      );
  }

  // Audited after the fact so a failed attempt is recorded too — "who tried to
  // grant themselves admin" is exactly the question this log has to answer.
  await audit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: `team.${action}`,
    entity: "team_member",
    entityId: body.get("id") ?? body.get("leadId") ?? null,
    metadata: {
      ok: result.ok,
      ...(result.ok ? {} : { error: result.error }),
      ...(action === "role" ? { role: body.get("role") } : {}),
    },
  });

  if (result.ok) {
    revalidatePath("/inbox/whatsapp/settings/access");
    revalidatePath("/inbox/whatsapp/settings/team");
    revalidatePath("/inbox/whatsapp/crm/leads");
  }

  return respond(request, body, redirectTo, result);
}
