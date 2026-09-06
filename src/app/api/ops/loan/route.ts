import { read } from "@/lib/db";
import { assertCustomerAccess, authorize } from "@/lib/ops/auth";
import { fail, handleError, ok } from "@/lib/ops/http";
import { assign } from "@/lib/ops/assignment";
import { syncDocumentFollowUps } from "@/lib/ops/followups";
import {
  addChecklistItems, applyChecklistTemplate, caseProgress, checklistFor, defaultChecklist, getCase,
  loanWorkspace, refreshCaseProgress, removeChecklistItem, setDefaultChecklist, setLoanStatus, updateChecklistItem,
} from "@/lib/ops/loan";
import type { ChecklistItem, LoanStatus } from "@/lib/ops/types";

export async function GET(req: Request) {
  try {
    const session = await authorize(req, "loan:read");
    const url = new URL(req.url);
    const caseId = url.searchParams.get("caseId");

    if (caseId) {
      const loanCase = getCase(caseId);
      if (!loanCase || loanCase.orgId !== session.orgId) return fail("Not found", 404);
      await assertCustomerAccess(session, loanCase.customerId);
      return ok({ loanCase, checklist: checklistFor(caseId), progress: caseProgress(caseId) });
    }

    // The query parameter is honoured for an ADMIN only. It used to be read
    // first for everyone, so a non-admin could name a colleague's id and read
    // their whole workspace — the fallback to their own id never ran, because
    // ?? only fires when the parameter is absent. Scoping is decided by the
    // session, and the parameter can only narrow within what the session allows.
    const officerId =
      session.role === "ADMIN" ? (url.searchParams.get("officerId") ?? undefined) : session.memberId;
    return ok({ workspace: loanWorkspace(session.orgId, officerId ?? undefined) });
  } catch (e) {
    return handleError(e);
  }
}

/**
 * Loan-officer actions. The checklist lives here and only here — there is
 * deliberately no path by which the assistant can add or remove a requirement.
 */
export async function POST(req: Request) {
  try {
    const session = await authorize(req, "loan:write");
    const body = (await req.json()) as {
      action: "addItems" | "applyTemplate" | "updateItem" | "removeItem" | "setStatus" | "requestDocuments" | "reassign" | "addNote" | "setDefaultChecklist";
      loanCaseId?: string;
      itemId?: string;
      templateId?: string;
      items?: Array<Pick<ChecklistItem, "documentType" | "customerLabel" | "description" | "required" | "acceptedFormats">>;
      patch?: Partial<ChecklistItem>;
      status?: LoanStatus;
      note?: string;
      assigneeId?: string;
      customerId?: string;
    };

    const loanCase = body.loanCaseId ? getCase(body.loanCaseId) : undefined;
    if (loanCase) {
      if (loanCase.orgId !== session.orgId) return fail("Not found", 404);
      await assertCustomerAccess(session, loanCase.customerId);
    }
    const actor = { id: session.memberId, type: "human" as const };

    switch (body.action) {
      case "addItems":
        if (!body.loanCaseId || !body.items) return fail("loanCaseId and items required", 400);
        return ok({ items: addChecklistItems(body.loanCaseId, body.items, actor) });

      case "applyTemplate":
        if (!body.loanCaseId || !body.templateId) return fail("loanCaseId and templateId required", 400);
        return ok({ items: applyChecklistTemplate(body.loanCaseId, body.templateId, actor) });

      case "updateItem":
        if (!body.itemId) return fail("itemId required", 400);
        return ok({ item: updateChecklistItem(body.itemId, body.patch ?? {}, actor) });

      case "removeItem":
        if (!body.itemId) return fail("itemId required", 400);
        return ok({ removed: removeChecklistItem(body.itemId, actor) });

      case "setStatus":
        if (!body.loanCaseId || !body.status) return fail("loanCaseId and status required", 400);
        return ok({ loanCase: setLoanStatus(body.loanCaseId, body.status, actor, body.note) });

      case "addNote": {
        if (!body.loanCaseId || !body.note) return fail("loanCaseId and note required", 400);
        const updated = setLoanStatus(body.loanCaseId, getCase(body.loanCaseId)!.status, actor, body.note);
        return ok({ loanCase: updated ?? getCase(body.loanCaseId) });
      }

      /** Mark items REQUESTED and let the follow-up engine take it from there. */
      case "requestDocuments": {
        if (!body.loanCaseId) return fail("loanCaseId required", 400);
        const items = checklistFor(body.loanCaseId).filter((i) => i.status === "NOT_REQUESTED");
        for (const i of items) updateChecklistItem(i.id, { status: "REQUESTED" }, actor);
        const followUps = syncDocumentFollowUps(body.loanCaseId);
        refreshCaseProgress(body.loanCaseId, actor);
        return ok({ requested: items.length, followUps: followUps.map((f) => f.id) });
      }

      /** The org's default document set, applied to every new case. */
      case "setDefaultChecklist": {
        if (!Array.isArray(body.items)) return fail("items required", 400);
        const items = setDefaultChecklist(session.orgId, body.items);
        return ok({ items, templateId: defaultChecklist(session.orgId).templateId });
      }

      case "reassign": {
        const customerId = body.customerId ?? loanCase?.customerId;
        if (!customerId) return fail("customerId required", 400);
        const result = assign({
          orgId: session.orgId,
          customerId,
          queue: "LOAN",
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

export async function PUT(req: Request) {
  try {
    const session = await authorize(req, "loan:read");
    const { customerId } = (await req.json()) as { customerId: string };
    await assertCustomerAccess(session, customerId);
    const db = read();
    const cases = db.loanCases.filter((l) => l.customerId === customerId);
    return ok({ cases: cases.map((c) => ({ ...c, progress: caseProgress(c.id) })) });
  } catch (e) {
    return handleError(e);
  }
}
