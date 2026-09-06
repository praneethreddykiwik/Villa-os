import { assertCustomerAccess, authorize, can } from "@/lib/ops/auth";
import { fail, handleError, ok } from "@/lib/ops/http";
import { getThread, markThreadRead } from "@/lib/ops/inbox";

export const dynamic = "force-dynamic";

/** Full two-way history for one customer. Opening it marks inbound messages read. */
export async function GET(req: Request) {
  try {
    const session = await authorize(req, "customer:read");
    const url = new URL(req.url);
    const customerId = url.searchParams.get("customerId");
    if (!customerId) return fail("customerId required", 400);
    await assertCustomerAccess(session, customerId);

    const markedRead = url.searchParams.get("markRead") === "0" ? 0 : markThreadRead(customerId);
    const thread = getThread(session.orgId, customerId);
    if (!thread) return fail("Not found", 404);

    // Document metadata is only shown to people who may read documents.
    const mayReadDocuments = can(session, "document:read");
    if (!mayReadDocuments) {
      thread.documents = [];
      thread.messages = thread.messages.map((m) => ({ ...m, document: undefined }));
    }
    return ok({ ...thread, markedRead, documentsRedacted: !mayReadDocuments, viewer: { memberId: session.memberId, name: session.name } });
  } catch (e) {
    return handleError(e);
  }
}
