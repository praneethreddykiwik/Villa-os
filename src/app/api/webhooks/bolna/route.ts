import { createHash, timingSafeEqual } from "node:crypto";
import { apiError, apiFail, apiOk } from "@/lib/auth/http";
import { bridgeCallToWhatsApp, notifyMissedCall } from "@/lib/osf/voice-bridge";
import { AuthError } from "@/lib/auth/session";
import { read, resolveBrandId } from "@/lib/db";
import { clientKey, rateLimit } from "@/lib/ops/ratelimit";
import { resolveDefaultOrgId } from "@/lib/ops/seed";
import { normaliseExecution } from "@/lib/bolna/client";
import { ingestExecution } from "@/lib/voice/calls";
import { pumpQueue, settleQueueEntry } from "@/lib/voice/queue";

export const dynamic = "force-dynamic";

/**
 * This handler does real work before it answers: an LLM extraction pass of up
 * to 20s, then Supabase writes, then a WhatsApp text, then one or more
 * multi-megabyte document sends that Evolution must download from us first.
 * Every comparable route in this app sets its own budget; without one this got
 * the platform default and was killed mid-delivery, after the customer had
 * already been told the brochure was on its way.
 */
export const maxDuration = 300;

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

  /**
   * Header first, query string accepted.
   *
   * The provider posts execution updates from its own servers and its
   * dashboard offers a URL field and nothing else — there is no way to attach
   * a custom header. Requiring one therefore meant the loop could not be
   * closed without standing a reverse proxy in front purely to add it, and
   * until somebody did, every finished call was dropped and no transcript,
   * lead or follow-up was ever created.
   *
   * So `?secret=` is accepted as well, exactly as the Evolution webhook
   * already does. The cost is real and worth stating: a query string is
   * recorded in access logs in a way a header is not, which makes this URL as
   * sensitive as the secret itself. Treat it accordingly — unguessable, never
   * pasted into a ticket or a screenshot, and rotated together with the
   * secret. Prefer the header wherever the sender can set one.
   */
  const presented =
    req.headers.get("x-voice-secret") ??
    new URL(req.url).searchParams.get("secret") ??
    "";

  // Hashed before comparing so the compare is constant-time on a fixed width:
  // a raw timingSafeEqual needs equal lengths, and the length check that makes
  // it safe to call is itself a signal about how long the secret is.
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  if (!timingSafeEqual(a, b)) {
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

    /**
     * Only once the call is FINISHED does it mean anything.
     *
     * Bolna posts progress updates too, and scoring a half-finished call would
     * mark a buyer cold for not yet having said the thing they were about to
     * say — then message them about it. `finalised` is true exactly once per
     * call, on the terminal update.
     *
     * Awaited rather than fired and forgotten: this runs on a serverless
     * function, and work still in flight when the response returns is killed
     * with the process. It cannot throw — bridgeCallToWhatsApp catches
     * everything and reports why — so a failed follow-up costs the follow-up,
     * never the call record.
     */
    let followUp: Awaited<ReturnType<typeof bridgeCallToWhatsApp>> | undefined;
    if (result.finalised) {
      const turns = result.record.turns ?? [];
      const transcript = turns.length
        ? turns.map((t) => `${t.role === "caller" ? "Caller" : "Agent"}: ${t.text}`).join("\n")
        : (result.record.transcript ?? "");
      followUp = await bridgeCallToWhatsApp({
        phone: result.record.callerPhone,
        name: result.record.extracted?.name ?? null,
        transcript,
        executionId: execution.id,
        customerTurns: turns.filter((t) => t.role === "caller").length,
      });
    }

    /**
     * The queue moves on.
     *
     * Settling first, dialling second: the finished entry has to leave the
     * `calling` state before the pump counts how many calls are in flight, or
     * the concurrency limit sees a slot that is already free as still taken
     * and the run stalls one call in.
     *
     * A no-answer goes back to `queued` with an hour's backoff — the person
     * did not refuse, they were not there — so the pump will usually find
     * nothing to do here and the cron heartbeat picks it up later.
     */
    let queue: { settled: string | null; dialled: number } | undefined;
    let missedCall: Awaited<ReturnType<typeof notifyMissedCall>> | undefined;
    if (result.finalised) {
      const settled = settleQueueEntry({
        executionId: execution.id,
        phone: result.record.callerPhone,
        brandId,
        outcome: result.record.outcome,
      });

      /**
       * Nobody picked up, and we are not going to ring them again.
       *
       * `settleQueueEntry` returns "queued" while retries remain and "failed"
       * once they are spent, so keying on "failed" is what makes this one
       * message per person rather than one per attempt. A number that rang out
       * is not a lead who said no — it is one we have not reached yet, and
       * WhatsApp is the cheaper second door.
       *
       * Awaited, like the follow-up above: on a serverless function anything
       * still in flight when the response returns is killed with the process.
       */
      if (settled?.status === "failed" && result.record.outcome === "no_answer") {
        missedCall = await notifyMissedCall({
          phone: result.record.callerPhone,
          name: result.record.extracted?.name ?? null,
          executionId: execution.id,
        });
      }

      const pumped = await pumpQueue(brandId).catch(() => ({ dialled: 0 }));
      queue = { settled: settled?.status ?? null, dialled: pumped.dialled };
    }

    return apiOk({
      executionId: execution.id,
      status: result.record.status,
      created: result.created,
      finalised: result.finalised,
      leadId: result.record.leadId,
      customerId: result.record.customerId,
      followUp,
      missedCall,
      queue,
    });
  } catch (e) {
    return apiError(e);
  }
}
