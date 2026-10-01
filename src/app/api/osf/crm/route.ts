import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { readPost, respond, safePath, type ActionResult } from "@/lib/osf/form-post";
import {
  assignRep,
  completeFollowUp,
  completeTask,
  createFollowUp,
  createTask,
  setAiPaused,
  setFutureProspect,
  setStage,
  startTask,
} from "@/lib/osf/crm";
import { guard } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every CRM write, behind one endpoint.
 *
 * The pages submit plain `<form method="POST">`, so each action must work with
 * zero client JS; `readPost` also accepts JSON so the agent or a cron can call
 * the same handlers. Only the response shape differs.
 */

/** Pages whose data any of these actions can change. */
const CRM_PATHS = [
  "/inbox/whatsapp/crm/leads",
  "/inbox/whatsapp/crm/pipeline",
  "/inbox/whatsapp/crm/follow-ups",
  "/inbox/whatsapp/crm/contacts",
  "/inbox/whatsapp/crm/customers",
];

export async function POST(request: Request) {
  const denied = await guard("sales.write");
  if (denied) return denied;
  const body = await readPost(request);
  const action = body.get("action");
  const redirectTo = safePath(body.get("next"), "/inbox/whatsapp/crm/leads");

  let result: ActionResult;

  switch (action) {
    case "assign_rep":
      result = await assignRep(body.get("leadId") ?? "", body.get("assignedTo") ?? null);
      break;

    case "set_stage":
      result = await setStage(body.get("leadId") ?? "", body.get("stage") ?? "");
      break;

    case "set_ai_paused":
      result = await setAiPaused(body.get("leadId") ?? "", body.bool("paused"));
      break;

    case "set_future_prospect":
      result = await setFutureProspect(
        body.get("leadId") ?? "",
        body.bool("isFutureProspect"),
        body.get("reconnectAt") ?? null,
      );
      break;

    case "create_task":
      result = await createTask({
        title: body.get("title") ?? "",
        description: body.get("description") ?? null,
        leadId: body.get("leadId") ?? null,
        assignedTo: body.get("assignedTo") ?? null,
        priority: body.get("priority"),
        taskType: body.get("taskType"),
        dueAt: body.get("dueAt") ?? null,
      });
      break;

    case "complete_task":
      result = await completeTask(body.get("id") ?? "");
      break;

    case "start_task":
      result = await startTask(body.get("id") ?? "");
      break;

    case "create_follow_up":
      result = await createFollowUp({
        leadId: body.get("leadId") ?? "",
        scheduledAt: body.get("scheduledAt") ?? "",
        assignedTo: body.get("assignedTo") ?? null,
        channel: body.get("channel"),
        message: body.get("message") ?? null,
        templateName: body.get("templateName") ?? null,
        notes: body.get("notes") ?? null,
      });
      break;

    case "complete_follow_up":
      result = await completeFollowUp(body.get("id") ?? "");
      break;

    default:
      return NextResponse.json(
        {
          error:
            "action must be one of assign_rep, set_stage, set_ai_paused, set_future_prospect, " +
            "create_task, start_task, complete_task, create_follow_up, complete_follow_up",
        },
        { status: 400 },
      );
  }

  if (result.ok) {
    for (const path of CRM_PATHS) revalidatePath(path);
    // The lead the form came from is a dynamic segment, so it needs its own
    // pass — revalidating "/inbox/whatsapp/crm/leads" does not reach "/inbox/whatsapp/crm/leads/[id]".
    const leadId = body.get("leadId");
    if (leadId) revalidatePath(`/inbox/whatsapp/crm/leads/${leadId}`);
  }

  return respond(request, body, redirectTo, result);
}
