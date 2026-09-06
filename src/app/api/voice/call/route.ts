import { read, resolveBrandId } from "@/lib/db";
import { actorLabel, requirePermission } from "@/lib/auth/session";
import { apiError, apiFail, apiOk } from "@/lib/auth/http";
import { rateLimit } from "@/lib/ops/ratelimit";
import { logActivity } from "@/lib/engine/publisher";
import { isConfigured, startCall, toE164 } from "@/lib/bolna/client";

export const dynamic = "force-dynamic";

/**
 * START AN OUTBOUND VOICE CALL.
 *
 * This route rings a real person's phone and spends real money, which is why it
 * is the strictest surface in this feature:
 *
 *   · `customers.write`, not a read scope — dialling a lead is contact with a
 *     customer, and marketing/analytics roles have no business initiating it.
 *   · Rate limited per user. A loop bug or a leaned-on button would otherwise
 *     dial the same person twenty times and bill for every attempt; the limit
 *     is the difference between a mistake and an incident.
 *   · The number must already be E.164. Nothing here guesses a country code.
 */

/** Twelve calls in five minutes is a busy desk. Anything past it is a fault. */
const LIMIT = { max: 12, windowSeconds: 300 } as const;

/** How many `user_data` keys the agent prompt could plausibly interpolate. */
const MAX_VARIABLES = 20;
const MAX_VARIABLE_CHARS = 300;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

async function jsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Flatten caller-supplied variables into the strings Bolna interpolates.
 *
 * Bounded and scalar-only on purpose: `user_data` is substituted into the
 * agent's prompt, so an unbounded object from a request body is a direct route
 * into what the agent says on a live call to a customer.
 */
function sanitiseVariables(input: unknown): Record<string, string> {
  const source = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (Object.keys(out).length >= MAX_VARIABLES) break;
    const name = key.trim();
    if (!name || !/^[a-zA-Z0-9_]{1,40}$/.test(name)) continue;
    const text =
      typeof value === "string" ? value
      : typeof value === "number" && Number.isFinite(value) ? String(value)
      : typeof value === "boolean" ? String(value)
      : null;
    if (text === null) continue;
    out[name] = text.slice(0, MAX_VARIABLE_CHARS);
  }
  return out;
}

export async function POST(req: Request) {
  try {
    const session = await requirePermission("customers.write");

    // Configuration is checked BEFORE the limiter. With no BOLNA_API_KEY every
    // click fails anyway, and charging each one against the quota locked the
    // operator out of the feature for a quarter of an hour the moment it worked.
    if (!isConfigured()) {
      return apiFail(
        "The voice agent is not connected. Ask an administrator to configure it before placing calls.",
        503,
      );
    }

    const limit = rateLimit(`voice:call:${session.userId}`, LIMIT);
    if (!limit.allowed) {
      return apiFail(
        `Too many calls started. Try again in ${limit.retryAfterSeconds ?? LIMIT.windowSeconds}s.`,
        429,
      );
    }

    // Checked before anything else is validated so an unconfigured deployment
    // says so, rather than rejecting the operator's perfectly good number.
    const body = await jsonBody(req);
    if (!body) return apiFail("Send a JSON object.");

    const agentId = str(body.agentId);
    if (!agentId) return apiFail("Choose an agent to make the call.");

    const db = read();
    const brandId = resolveBrandId(db, str(body.brandId) || undefined);

    // A lead is optional — the desk sometimes has a number and no record yet —
    // but when one is named it must exist in this brand, or the call would be
    // logged against somebody else's pipeline.
    const leadId = str(body.leadId);
    const lead = leadId ? db.leads.find((l) => l.id === leadId && l.brandId === brandId) : undefined;
    if (leadId && !lead) return apiFail("That lead is not in this brand.", 404);

    const requested = str(body.phone) || lead?.phone || "";
    if (!requested) return apiFail("No number to call — pick a lead with a phone number, or type one.");

    const phone = toE164(requested);
    if (!phone) {
      return apiFail(
        `The voice agent dials E.164 numbers only. "${requested}" needs its country code, e.g. +91${requested.replace(/[^\d]/g, "").slice(-10)}.`,
      );
    }

    // The agent's prompt addresses the person by name. Caller-supplied
    // variables come first so the lead's real name cannot be overridden by a
    // stray `lead_name` in the request body.
    const variables = sanitiseVariables(body.variables);
    const userData: Record<string, string> = { ...variables };
    if (lead) {
      userData.lead_name = lead.name;
      if (lead.projectInterest) userData.project = lead.projectInterest;
    }

    const result = await startCall({ agentId, phone, userData });
    if (!result.ok) {
      // The provider's own words, verbatim. "Bolna answered HTTP 402: balance
      // exhausted" is actionable; "could not start call" sends somebody to read
      // server logs they cannot see.
      return apiFail(result.error, result.reason === "unconfigured" ? 503 : 502);
    }

    logActivity(
      brandId,
      "voice_call_started",
      `Voice agent called ${lead ? lead.name : phone}${result.data.executionId ? ` (execution ${result.data.executionId})` : ""}`,
      actorLabel(session),
    );

    return apiOk({ call: result.data, leadId: lead?.id ?? null, phone }, 202);
  } catch (e) {
    return apiError(e);
  }
}
