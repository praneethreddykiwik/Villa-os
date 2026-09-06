import { read } from "@/lib/db";
import { authorize } from "@/lib/ops/auth";
import { handleError, ok } from "@/lib/ops/http";
import { listConversations, type InboxFilter } from "@/lib/ops/inbox";

export const dynamic = "force-dynamic";

/** Conversation list for the WhatsApp inbox, scoped the same way as the customer list. */
export async function GET(req: Request) {
  try {
    const session = await authorize(req, "customer:read");
    const url = new URL(req.url);
    const filter = (url.searchParams.get("filter") ?? "all") as InboxFilter;
    const q = url.searchParams.get("q") ?? undefined;

    let customerIds: Set<string> | undefined;
    if (session.role !== "ADMIN") {
      const mine = read().customers.filter((c) =>
        c.orgId === session.orgId &&
        (session.role === "SALES_MANAGER" ? c.assignedSalesManagerId === session.memberId : c.assignedLoanOfficerId === session.memberId),
      );
      customerIds = new Set(mine.map((c) => c.id));
    }
    const conversations = listConversations(session.orgId, { filter, q, customerIds });
    return ok({ conversations, unreadTotal: conversations.reduce((n, c) => n + c.unread, 0) });
  } catch (e) {
    return handleError(e);
  }
}
