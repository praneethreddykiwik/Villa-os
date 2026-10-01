import { read } from "@/lib/db";
import { assertCustomerAccess, authorize, can } from "@/lib/ops/auth";
import { fail, handleError, ok } from "@/lib/ops/http";
import { setControl, setStage, snapshot, updateCustomer } from "@/lib/ops/customers";
import { sentimentTimeline } from "@/lib/ops/intelligence";
import { buildBriefing } from "@/lib/ops/sales";
import { activeCase, caseProgress, checklistFor } from "@/lib/ops/loan";
import { documentsFor } from "@/lib/ops/documents";
import type { LeadStage } from "@/lib/ops/types";

/** List (scoped by role) or fetch one Customer-360 payload. */
export async function GET(req: Request) {
  try {
    const session = await authorize(req, "customer:read");
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    const db = read();

    if (!id) {
      const all = db.customers.filter((c) => c.orgId === session.orgId);
      const scoped =
        session.role === "ADMIN"
          ? all
          : all.filter((c) =>
              session.role === "SALES_MANAGER"
                ? c.assignedSalesManagerId === session.memberId
                : c.assignedLoanOfficerId === session.memberId,
            );
      return ok({ customers: scoped });
    }

    await assertCustomerAccess(session, id);
    const snap = snapshot(id);
    if (!snap) return fail("Not found", 404);

    const loanCase = activeCase(id);
    // Sales cannot see documents — the payload omits them rather than relying on
    // the client to hide what it was sent.
    const mayReadDocuments = can(session, "document:read");

    return ok({
      customer: snap.customer,
      snapshot: snap,
      briefing: buildBriefing(id),
      sentimentTimeline: sentimentTimeline(id),
      scores: db.scoreEvents.filter((s) => s.customerId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      insights: db.conversationInsights.filter((i) => i.customerId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      messages: db.opsMessages.filter((m) => m.customerId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      salesTasks: db.salesTasks.filter((t) => t.customerId === id),
      assignments: db.assignments.filter((a) => a.customerId === id),
      loanCase: loanCase ?? null,
      checklist: loanCase ? checklistFor(loanCase.id) : [],
      progress: loanCase ? caseProgress(loanCase.id) : null,
      documents: mayReadDocuments ? documentsFor(id) : [],
      documentsRedacted: !mayReadDocuments,
      followUps: db.followUps.filter((f) => f.customerId === id),
      escalations: db.escalations.filter((e) => e.customerId === id),
      timeline: db.auditEvents
        .filter((a) => a.customerId === id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    });
  } catch (e) {
    return handleError(e);
  }
}


/**
 * The fields a profile edit may write.
 *
 * Deliberately absent, each because it has its own audited path:
 *   · leadStage                  → the `stage` branch below, via setStage()
 *   · salesControl / loanControl → the `control` branch below, via setControl()
 *   · optedOut                   → the consent path; a profile edit must never
 *                                  be able to un-opt-out somebody
 *   · leadScore, sentiment, sentimentConfidence → written by scoring, not by hand
 *   · id, orgId, createdAt, updatedAt           → identity and audit columns
 *
 * An allowlist rather than a denylist because a denylist fails open: every
 * field later added to `Customer` would become remotely writable the moment it
 * was declared, with nothing to notice.
 */
const PATCHABLE_CUSTOMER_FIELDS = [
  "name", "phone", "email", "source", "leadStatus",
  "assignedSalesManagerId", "assignedLoanOfficerId",
  "loanRequired", "intent",
  "lastInteractionAt", "nextFollowUpAt", "preferredChannel",
  "preferences", "budgetMin", "budgetMax",
  "purchaseInfo", "financingInfo", "notes", "tags",
  "leadId", "contactId",
] as const;

function pickPatchable(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of PATCHABLE_CUSTOMER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, f) && patch[f] !== undefined) out[f] = patch[f];
  }
  return out;
}

/** Profile edits, stage moves and human takeover. */
export async function PATCH(req: Request) {
  try {
    const session = await authorize(req, "customer:write");
    const body = (await req.json()) as {
      customerId: string;
      patch?: Record<string, unknown>;
      stage?: LeadStage;
      control?: { lane: "SALES" | "LOAN"; state: "AI_ACTIVE" | "HUMAN_CONTROL" };
    };
    await assertCustomerAccess(session, body.customerId);

    let customer = null;
    if (body.patch) {
      // Allowlisted, not passed through. `body.patch` is an arbitrary object
      // from the network: forwarding it whole is mass assignment, and the
      // fields it must not reach are the dangerous ones — `optedOut` would let
      // a profile edit silently un-opt-out someone who asked to be left alone,
      // and the control lanes would hand a paused thread back to the AI while
      // a human is mid-conversation. Each of those has its own audited path.
      customer = updateCustomer(body.customerId, pickPatchable(body.patch), {
        id: session.memberId,
        type: "human",
      });
    }
    if (body.stage) {
      customer = setStage(body.customerId, body.stage, { id: session.memberId, type: "human" });
    }
    if (body.control) {
      customer = setControl(body.customerId, body.control.lane, body.control.state, {
        id: session.memberId,
        type: "human",
      });
    }
    return ok({ customer });
  } catch (e) {
    return handleError(e);
  }
}
