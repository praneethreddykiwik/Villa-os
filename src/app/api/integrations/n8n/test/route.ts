import { apiError, apiFail, apiOk } from "@/lib/auth/http";
import { requirePermission } from "@/lib/auth/session";
import { sendTestEvent } from "@/lib/events/bus";
import { rateLimit } from "@/lib/ops/ratelimit";

/**
 * PROBE ONE SUBSCRIBER.
 *
 * Registering a webhook is the easy half; finding out that the URL had a typo,
 * or that the workflow's signature check rejects everything, currently waits for
 * the next real booking. This fires a marked probe at one endpoint and returns
 * the delivery record — status, attempts, error — so that answer arrives while
 * the operator is still on the screen.
 *
 * `workflows.manage`, the same grant the registry itself needs: the ability to
 * make this server issue an outbound request to a chosen host is exactly the
 * capability that registering the subscriber conferred, so it cannot be a weaker
 * gate. `requirePermission` rather than `guard` because the rate limit is keyed
 * on the caller, and a limit keyed on nothing is not a limit.
 */
export async function POST(req: Request) {
  try {
    const session = await requirePermission("workflows.manage");

    // Each call is up to three outbound requests with a ten-second timeout, so
    // an impatient click-through is a small outbound flood aimed at whichever
    // host is registered. Bounded per account.
    const limit = rateLimit(`n8n:test:${session.userId}`, { max: 20, windowSeconds: 300, lockoutSeconds: 300 });
    if (!limit.allowed) {
      return apiFail(`Too many test events. Try again in ${limit.retryAfterSeconds ?? 300} seconds.`, 429);
    }

    let body: { subscriberId?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return apiFail("The request body must be JSON.", 400);
    }

    const subscriberId = typeof body.subscriberId === "string" ? body.subscriberId : "";
    if (!subscriberId) return apiFail("Which subscriber? Pass subscriberId.", 400);

    const delivery = await sendTestEvent(subscriberId);
    if (!delivery) return apiFail("That subscriber does not exist.", 404);

    // A refused or unreachable endpoint is not a failure of *this* request — the
    // probe ran and reported. The caller reads `delivery.ok`, and the record is
    // in the same log every real delivery lands in.
    return apiOk({ delivery });
  } catch (e) {
    return apiError(e);
  }
}
