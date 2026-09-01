import { NextResponse } from "next/server";
import { read } from "@/lib/db";
import { assertCustomerAccess, authorize, can } from "@/lib/ops/auth";
import { handleError, ok } from "@/lib/ops/http";
import { documentsFor, documentTimeline, receiveDocument, recordDownload, reviewDocument } from "@/lib/ops/documents";
import { notifyDocumentDecision } from "@/lib/ops/agent";
import { documentStore, signDocumentRef, verifyDocumentRef } from "@/lib/ops/storage";
import { getCase } from "@/lib/ops/loan";

/**
 * Document endpoints.
 *
 * Downloads are double-locked: a short-lived signature bound to the requesting
 * member, AND a fresh server-side permission check on every request. Either one
 * alone is insufficient — a signature can leak, and a permission check alone
 * would let any authenticated officer enumerate ids.
 */
export async function GET(req: Request) {
  try {
    const session = await authorize(req, "document:read");
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    const customerId = url.searchParams.get("customerId");
    const download = url.searchParams.get("download");

    if (customerId && !id) {
      await assertCustomerAccess(session, customerId);
      return ok({ documents: documentsFor(customerId) });
    }
    if (!id) return ok({ error: "id or customerId required" }, 400);

    const doc = read().documents.find((d) => d.id === id);
    if (!doc || doc.orgId !== session.orgId) return ok({ error: "Not found" }, 404);
    await assertCustomerAccess(session, doc.customerId);

    // The officer must own the case; admins may read any.
    if (doc.loanCaseId && session.role === "LOAN_OFFICER") {
      const lc = getCase(doc.loanCaseId);
      if (lc?.assignedOfficerId !== session.memberId) return ok({ error: "Not your case" }, 403);
    }

    if (!download) {
      return ok({
        document: doc,
        events: documentTimeline(id),
        // Short TTL: a link pasted into a chat should be dead within minutes.
        downloadToken: signDocumentRef(id, session.memberId, 300),
      });
    }

    if (!can(session, "document:download")) return ok({ error: "Missing permission" }, 403);
    if (!verifyDocumentRef(id, session.memberId, download)) {
      return ok({ error: "Invalid or expired download token" }, 403);
    }

    const data = await documentStore().get(doc.storageKey);
    if (!data) return ok({ error: "File missing from storage" }, 404);
    recordDownload(id, session.memberId, doc.orgId);

    return new NextResponse(new Uint8Array(data), {
      headers: {
        "content-type": doc.mimeType,
        // attachment + nosniff: never render a customer upload inline.
        "content-disposition": `attachment; filename="${doc.filename.replace(/"/g, "")}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  } catch (e) {
    return handleError(e);
  }
}

/** Human upload on the customer's behalf (e.g. emailed in, scanned at a desk). */
export async function POST(req: Request) {
  try {
    const session = await authorize(req, "document:review");
    const form = await req.formData();
    const file = form.get("file");
    const customerId = String(form.get("customerId") ?? "");
    const checklistItemId = form.get("checklistItemId") ? String(form.get("checklistItemId")) : undefined;
    if (!(file instanceof File) || !customerId) return ok({ error: "file and customerId are required" }, 400);
    await assertCustomerAccess(session, customerId);

    const result = await receiveDocument({
      orgId: session.orgId,
      customerId,
      filename: file.name,
      mimeType: file.type,
      data: Buffer.from(await file.arrayBuffer()),
      checklistItemId,
      uploadedBy: "human",
      uploadedById: session.memberId,
    });
    if (!result.ok) return ok({ error: result.error }, 422);
    return ok({ document: result.document, duplicate: result.duplicate });
  } catch (e) {
    return handleError(e);
  }
}

/** The review decision. Only this path can set ACCEPTED. */
export async function PATCH(req: Request) {
  try {
    const session = await authorize(req, "document:review");
    const body = (await req.json()) as { documentId: string; decision: "ACCEPTED" | "REJECTED"; rejectionReason?: string };

    const doc = read().documents.find((d) => d.id === body.documentId);
    if (!doc || doc.orgId !== session.orgId) return ok({ error: "Not found" }, 404);
    await assertCustomerAccess(session, doc.customerId);

    const result = reviewDocument(body.documentId, body.decision, { id: session.memberId, type: "human" }, body.rejectionReason);
    if (!result.ok) return ok({ error: result.error }, 422);

    // Tell the customer what changed. Never blocks the review if messaging fails.
    let customerNotified: { sent: boolean; reason?: string } = { sent: false, reason: "no linked checklist item" };
    if (doc.loanCaseId && doc.checklistItemId) {
      customerNotified = await notifyDocumentDecision(doc.loanCaseId, doc.checklistItemId);
    }
    return ok({ document: result.document, customerNotified });
  } catch (e) {
    return handleError(e);
  }
}
