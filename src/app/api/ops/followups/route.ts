import { read } from "@/lib/db";
import { authorize } from "@/lib/ops/auth";
import { handleError, ok } from "@/lib/ops/http";
import { runFollowUpTick } from "@/lib/ops/agent";
import { cancelFollowUps, dueFollowUps, resolveEscalation } from "@/lib/ops/followups";
import { defaultOrgId } from "@/lib/ops/seed";

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
    const secret = req.headers.get("x-worker-secret") ?? url.searchParams.get("secret");
    const viaSecret = Boolean(process.env.WORKER_SECRET) && secret === process.env.WORKER_SECRET;

    let orgId = url.searchParams.get("orgId") ?? defaultOrgId();
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
    return ok({ error: "Nothing to do" }, 400);
  } catch (e) {
    return handleError(e);
  }
}
