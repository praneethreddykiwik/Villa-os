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
      customer = updateCustomer(body.customerId, body.patch, { id: session.memberId, type: "human" });
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
