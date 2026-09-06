import { timingSafeEqual } from "node:crypto";
import { apiError, apiFail, apiOk } from "@/lib/auth/http";
import { AuthError } from "@/lib/auth/session";
import { read, resolveBrandId } from "@/lib/db";
import { clientKey, rateLimit } from "@/lib/ops/ratelimit";
import { resolveDefaultOrgId } from "@/lib/ops/seed";
import { normaliseExecution } from "@/lib/bolna/client";
import { ingestExecution } from "@/lib/voice/calls";

export const dynamic = "force-dynamic";

/**
 * VOICE AGENT — execution updates from the provider.
 *
 * The provider POSTs the execution payload on every status change. This path
 * is listed in SELF_AUTHENTICATING in src/middleware.ts, so the shared secret
 * below is the only thing between the internet and a write to the customer
 * list — hence constant-time and fail-closed, following the n8n webhook.
 *
 * Every payload is stored; the terminal ones additionally create the customer,
 * transcript, lead and notification (see src/lib/voice/calls.ts). Replays are
 * safe: the record is keyed by execution id and the side effects run once.
 */
function requireVoiceSecret(req: Request): void {
  const expected = process.env.VOICE_WEBHOOK_SECRET;
  if (!expected) throw new AuthError("The voice webhook is not configured.", 503);
  const presented = req.headers.get("x-voice-secret") ?? "";
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AuthError("Invalid webhook credentials.", 401);
  }
}

/** The provider's payload is an execution; some senders wrap it. */
function unwrap(body: unknown): unknown {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const r = body as Record<string, unknown>;
    for (const key of ["execution", "data", "payload"]) {
      const inner = r[key];
      if (inner && typeof inner === "object" && !Array.isArray(inner) && ("id" in inner || "execution_id" in inner)) {
        return inner;
      }
    }
  }
  return body;
}

export async function POST(req: Request) {
  try {
    const limit = rateLimit(`voice-webhook:${clientKey(req)}`, { max: 240, windowSeconds: 60, lockoutSeconds: 300 });
    if (!limit.allowed) return apiFail(`Too many requests. Retry in ${limit.retryAfterSeconds ?? 60}s.`, 429);

    requireVoiceSecret(req);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiFail("The request body must be JSON.", 400);
    }

    const execution = normaliseExecution(unwrap(body));
    if (!execution) return apiFail("The payload has no execution id.", 400);

    const db = read();
    const brandId = resolveBrandId(db, new URL(req.url).searchParams.get("brand"));
  {
    const { getSession, assertBrandAccess } = require("@/lib/auth/session");
    const session = await getSession();
    if (session) assertBrandAccess(session, brandId);
  }
    if (!brandId) return apiFail("No brand is configured to attach the call to.", 409);
    const orgId = await resolveDefaultOrgId();

    const result = ingestExecution(execution, { brandId, orgId });
    return apiOk({
      executionId: execution.id,
      status: result.record.status,
      created: result.created,
      finalised: result.finalised,
      leadId: result.record.leadId,
      customerId: result.record.customerId,
    });
  } catch (e) {
    return apiError(e);
  }
}
