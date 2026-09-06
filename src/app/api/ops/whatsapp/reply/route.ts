import { assertCustomerAccess, authorize } from "@/lib/ops/auth";
import { fail, handleError, ok } from "@/lib/ops/http";
import { deliver } from "@/lib/ops/agent";
import { getThread } from "@/lib/ops/inbox";

export const dynamic = "force-dynamic";

/**
 * Human reply from the inbox. Goes through deliver(), so it is recorded in the
 * conversation with the staff member as author and respects the 24-hour
 * service window: outside it the words are queued and the client is told a
 * template is required instead of the send failing silently.
 */
export async function POST(req: Request) {
  try {
    const session = await authorize(req, "customer:write");
    const body = (await req.json().catch(() => ({}))) as { customerId?: string; text?: string };
    const customerId = body.customerId?.trim();
    const text = body.text?.trim();
    if (!customerId) return fail("customerId required", 400);
    if (!text) return fail("Message text required", 400);
    if (text.length > 4096) return fail("Message too long (4096 characters max)", 400);
    await assertCustomerAccess(session, customerId);

    const res = await deliver(session.orgId, customerId, text, "human", session.memberId);
    if (!res.ok) {
      return fail(
        res.requiresTemplate
          ? "The 24-hour reply window has closed. Send an approved template or call the customer; your message is queued and will go out when they write again."
          : res.error ?? "Send failed",
        res.requiresTemplate ? 409 : 422,
      );
    }
    const thread = getThread(session.orgId, customerId);
    return ok({ sent: true, messages: thread?.messages ?? [] });
  } catch (e) {
    return handleError(e);
  }
}
