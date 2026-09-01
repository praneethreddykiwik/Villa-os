import { read } from "@/lib/db";
import { assertCustomerAccess, authorize } from "@/lib/ops/auth";
import { fail, handleError, ok } from "@/lib/ops/http";
import { assign } from "@/lib/ops/assignment";
import { salesWorkspace, updateSalesTask } from "@/lib/ops/sales";
import { setStage, updateCustomer } from "@/lib/ops/customers";
import { createLoanCase } from "@/lib/ops/loan";
import type { SalesTaskStatus } from "@/lib/ops/types";

export async function GET(req: Request) {
  try {
    const session = await authorize(req, "sales:read");
    const url = new URL(req.url);
    // The query parameter is honoured for an ADMIN only. It used to be read
    // first for everyone, so a non-admin could name a colleague's id and read
    // their whole workspace — the fallback to their own id never ran, because
    // ?? only fires when the parameter is absent. Scoping is decided by the
    // session, and the parameter can only narrow within what the session allows.
    const memberId =
      session.role === "ADMIN" ? (url.searchParams.get("memberId") ?? undefined) : session.memberId;
    return ok({ workspace: salesWorkspace(session.orgId, memberId ?? undefined) });
  } catch (e) {
    return handleError(e);
  }
}

/**
 * The sales-manager call flow. `markFinancingRequired` is the pivot in the whole
 * lifecycle: it flips the customer, opens the loan case and routes it to the
 * loan queue in one atomic-from-the-caller's-view action, so a manager cannot
 * half-complete the handoff.
 */
export async function POST(req: Request) {
  try {
    const session = await authorize(req, "sales:write");
    const body = (await req.json()) as {
      action:
        | "updateTask"
        | "logCall"
        | "markQualified"
        | "markNotInterested"
        | "markFinancingRequired"
        | "reassign";
      customerId?: string;
      taskId?: string;
      status?: SalesTaskStatus;
      note?: string;
      assigneeId?: string;
      loanType?: string;
      requestedAmount?: number;
      loanOfficerId?: string;
      requirements?: string[];
    };

    if (body.customerId) await assertCustomerAccess(session, body.customerId);
    const actor = { id: session.memberId, type: "human" as const };

    switch (body.action) {
      case "updateTask": {
        if (!body.taskId) return fail("taskId required", 400);
        return ok({ task: updateSalesTask(body.taskId, { status: body.status, note: body.note }, actor) });
      }

      case "logCall": {
        if (!body.customerId) return fail("customerId required", 400);
        const open = read().salesTasks.find(
          (t) => t.customerId === body.customerId && ["OPEN", "IN_PROGRESS"].includes(t.status),
        );
        if (open) updateSalesTask(open.id, { status: "COMPLETED", note: body.note ?? "Call completed" }, actor);
        setStage(body.customerId, "SALES_CALL", actor, "Sales call completed");
        const customer = updateCustomer(
          body.customerId,
          {
            lastInteractionAt: new Date().toISOString(),
            notes: body.note ?? "",
            ...(body.requirements?.length
              ? { preferences: Object.fromEntries(body.requirements.map((r, i) => [`requirement_${i + 1}`, r])) }
              : {}),
          },
          actor,
        );
        return ok({ customer });
      }

      case "markQualified":
        if (!body.customerId) return fail("customerId required", 400);
        return ok({ customer: setStage(body.customerId, "QUALIFIED", actor, body.note) });

      case "markNotInterested": {
        if (!body.customerId) return fail("customerId required", 400);
        updateCustomer(body.customerId, { intent: "NOT_INTERESTED", leadStatus: "lost" }, actor);
        return ok({ customer: setStage(body.customerId, "LOST", actor, body.note) });
      }

      case "markFinancingRequired": {
        if (!body.customerId) return fail("customerId required", 400);
        setStage(body.customerId, "FINANCING_REQUIRED", actor, "Sales confirmed financing is required");
        const { loanCase, created } = createLoanCase({
          orgId: session.orgId,
          customerId: body.customerId,
          loanType: body.loanType,
          requestedAmount: body.requestedAmount,
          actorId: session.memberId,
          actorType: "human",
          assigneeId: body.loanOfficerId,
        });
        return ok({ loanCase, created });
      }

      case "reassign": {
        if (!body.customerId) return fail("customerId required", 400);
        const result = assign({
          orgId: session.orgId,
          customerId: body.customerId,
          queue: "SALES",
          assigneeId: body.assigneeId,
          reason: body.note ?? "Manual reassignment",
          actorId: session.memberId,
          actorType: "human",
        });
        return ok({ assignment: result.assignment, assignee: result.assignee ?? null });
      }

      default:
        return fail("Unknown action", 400);
    }
  } catch (e) {
    return handleError(e);
  }
}
