import { requirePermission } from "@/lib/auth/session";
import { apiError, apiOk } from "@/lib/auth/http";
import { rateLimit } from "@/lib/ops/ratelimit";
import { read, resolveBrandId } from "@/lib/db";
import { checkAll, clearHealthCache, webhookHealth } from "@/lib/platforms/health";

/**
 * CHANNEL HEALTH
 *
 * Asks every connected platform whether the credential still works, rather than
 * repeating the status string stored beside it. The screen renders from the
 * stored values on first paint and calls this to replace them with the truth.
 *
 * POST does the same work but clears the cache first, so the "Check again"
 * button means what it says. It is a POST because it costs outbound API calls
 * against Meta's rate limit — that is a side effect, and a GET should not have
 * one that an accidental prefetch could trigger.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(brandParam: string | null, fresh: boolean) {
  const session = await requirePermission("marketing.read");

  // Probing is outbound traffic on someone else's quota. One operator leaning
  // on the button must not exhaust the app's Graph allowance for everyone.
  const limit = rateLimit(`channels:health:${session.userId}`, {
    max: fresh ? 10 : 60,
    windowSeconds: 60,
    lockoutSeconds: 60,
  });
  if (!limit.allowed) {
    return apiOk({
      throttled: true,
      retryAfterSeconds: limit.retryAfterSeconds ?? 60,
      channels: [],
      webhooks: webhookHealth(),
    });
  }

  if (fresh) clearHealthCache();

  const db = read();
  const brandId = resolveBrandId(db, brandParam);
  const connections = db.connections.filter((c) => c.brandId === brandId);

  return apiOk({
    throttled: false,
    channels: await checkAll(connections),
    webhooks: webhookHealth(),
  });
}

export async function GET(req: Request) {
  try {
    return await handle(new URL(req.url).searchParams.get("brand"), false);
  } catch (e) {
    return apiError(e);
  }
}

export async function POST(req: Request) {
  try {
    return await handle(new URL(req.url).searchParams.get("brand"), true);
  } catch (e) {
    return apiError(e);
  }
}
