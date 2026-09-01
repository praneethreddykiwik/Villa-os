import { read } from "@/lib/db";
import { authorize } from "@/lib/ops/auth";
import { fail, handleError, ok } from "@/lib/ops/http";
import { runFollowUpTick } from "@/lib/ops/agent";
import { cancelFollowUps, dueFollowUps, resolveEscalation } from "@/lib/ops/followups";
import { defaultOrgId } from "@/lib/ops/seed";
import { requireWorkerSecret } from "@/lib/auth/session";

/**
 * Follow-up worker. Point a cron here.
 *
 * Protected by the shared worker secret so it can run headlessly, or by a normal
 * session for the "run now" button. It never bypasses the send guards — quiet
 * hours, cooldown, daily cap, opt-out and human control all still apply.
 */
export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    // Constant-time, and fails closed on a missing secret.
    let viaSecret = false;
    try {
      await requireWorkerSecret(req);
      viaSecret = true;
    } catch {
      viaSecret = false;
    }

    // The worker runs for its own org only. Taking orgId from the query string
    // let anyone holding the shared secret drive follow-ups — real WhatsApp
    // messages to real customers — against any tenant they named.
    let orgId = defaultOrgId();
    if (!viaSecret) {
      const session = await authorize(req, "admin:read");
      orgId = session.orgId;
    }

    const dryRun = url.searchParams.get("dryRun") === "true";
    if (dryRun) {
      const preview = dueFollowUps(orgId);
      return ok({
        dryRun: true,
        considered: preview.considered,
        wouldSend: preview.due.map((d) => ({ id: d.followUp.id, kind: d.followUp.kind, message: d.message })),
        skipped: preview.skipped,
        escalated: preview.escalated,
      });
    }

    return ok({ result: await runFollowUpTick(orgId) });
  } catch (e) {
    return handleError(e);
  }
}

export async function GET(req: Request) {
  try {
    const session = await authorize(req, "customer:read");
    const url = new URL(req.url);
    const customerId = url.searchParams.get("customerId");
    const db = read();
    return ok({
      followUps: db.followUps.filter((f) => f.orgId === session.orgId && (!customerId || f.customerId === customerId)),
      escalations: db.escalations.filter((e) => e.orgId === session.orgId && (!customerId || e.customerId === customerId)),
    });
  } catch (e) {
    return handleError(e);
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await authorize(req, "customer:write");
    const body = (await req.json()) as { escalationId?: string; cancelCustomerId?: string; reason?: string };
    if (body.escalationId) return ok({ escalation: resolveEscalation(body.escalationId, session.memberId) });
    if (body.cancelCustomerId) {
      return ok({ cancelled: cancelFollowUps({ customerId: body.cancelCustomerId }, body.reason ?? "Cancelled by a human") });
    }
    return fail("Nothing to do", 400);
  } catch (e) {
    return handleError(e);
  }
}
