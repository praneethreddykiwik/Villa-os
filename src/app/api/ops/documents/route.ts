import { NextResponse } from "next/server";
import { read } from "@/lib/db";
import { assertCustomerAccess, authorize } from "@/lib/ops/auth";
import { fail, handleError, ok } from "@/lib/ops/http";
import { documentsFor, documentTimeline, receiveDocument, recordDownload, reviewDocument } from "@/lib/ops/documents";
import { notifyDocumentDecision } from "@/lib/ops/agent";
import { documentStore, signDocumentRef, verifyDocumentRef } from "@/lib/ops/storage";
import { getCase } from "@/lib/ops/loan";

/**
 * Document endpoints.
 *
 * Downloads were described here as double-locked: a short-lived signature bound
 * to the requesting member, AND a second server-side permission check. The
 * second lock was not real. It tested `document:download`, which the ops
 * permission map aliased to `documents.read` — the very permission `authorize`
 * had already required three lines earlier — so it could not deny anybody. A
 * control that cannot fail is worse than no control: it is trusted, it is cited
 * when someone asks whether a leaked link is survivable, and it hides the fact
 * that nothing extra was ever checked.
 *
 * So the fake lock is gone and what remains is stated honestly. A download must
 * still clear the read permission, the org boundary, the per-customer ownership
 * check, the assigned-officer check on a loan case, and a signature bound to
 * this member that expires in five minutes. Giving downloads a permission of
 * their own — the distinct second lock the comment used to promise — needs a
 * `documents.download` row and role grants in the database, which is a schema
 * change, not an entry in a translation table.
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
    if (!id) return fail("id or customerId required", 400);

    const doc = read().documents.find((d) => d.id === id);
    if (!doc || doc.orgId !== session.orgId) return fail("Not found", 404);
    await assertCustomerAccess(session, doc.customerId);

    // The officer must own the case; admins may read any.
    if (doc.loanCaseId && session.role === "LOAN_OFFICER") {
      const lc = getCase(doc.loanCaseId);
      if (lc?.assignedOfficerId !== session.memberId) return fail("Not your case", 403);
    }

    if (!download) {
      return ok({
        document: doc,
        events: documentTimeline(id),
        // Short TTL: a link pasted into a chat should be dead within minutes.
        downloadToken: signDocumentRef(id, session.memberId, 300),
      });
    }

    if (!verifyDocumentRef(id, session.memberId, download)) {
      return fail("Invalid or expired download token", 403);
    }

    const data = await documentStore().get(doc.storageKey);
    if (!data) return fail("File missing from storage", 404);
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
    if (!(file instanceof File) || !customerId) return fail("file and customerId are required", 400);
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
    if (!result.ok) return fail(result.error, 422);
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
    if (!doc || doc.orgId !== session.orgId) return fail("Not found", 404);
    await assertCustomerAccess(session, doc.customerId);

    const result = reviewDocument(body.documentId, body.decision, { id: session.memberId, type: "human" }, body.rejectionReason);
    if (!result.ok) return fail(result.error, 422);

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
