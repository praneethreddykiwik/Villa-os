import { assertCustomerAccess, authorize } from "@/lib/ops/auth";
import { fail, handleError, ok } from "@/lib/ops/http";
import { setInboxControl } from "@/lib/ops/inbox";

export const dynamic = "force-dynamic";

/** Pause or resume the AI for one customer's sales conversation. */
export async function POST(req: Request) {
  try {
    const session = await authorize(req, "customer:write");
    const body = (await req.json().catch(() => ({}))) as { customerId?: string; paused?: boolean };
    if (!body.customerId) return fail("customerId required", 400);
    if (typeof body.paused !== "boolean") return fail("paused must be true or false", 400);
    await assertCustomerAccess(session, body.customerId);
    const customer = setInboxControl(body.customerId, body.paused, { id: session.memberId, type: "human" });
    if (!customer) return fail("Not found", 404);
    return ok({ customer, mode: customer.salesControl === "HUMAN_CONTROL" ? "human" : "ai" });
  } catch (e) {
    return handleError(e);
  }
}
