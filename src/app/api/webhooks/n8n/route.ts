import { timingSafeEqual } from "node:crypto";
import { apiError, apiFail, apiOk } from "@/lib/auth/http";
import { AuthError } from "@/lib/auth/session";
import { mutate, read, resolveBrandId } from "@/lib/db";
import { uid } from "@/lib/ids";
import { scoreLead } from "@/lib/crm/rules";
import { logActivity } from "@/lib/engine/publisher";
import { book, normalisePhone } from "@/lib/appointments/engine";
import type { AppointmentChannel } from "@/lib/appointments/types";
import { rememberReceipt, replayReceipt } from "@/lib/events/bus";
import { clientKey, rateLimit } from "@/lib/ops/ratelimit";
import type { Lead, LeadSource } from "@/lib/crm/types";
import { isN8nPlatform } from "@/lib/automation/types";
import { recordPlatformResult } from "@/lib/automation/video-post";

/**
 * INBOUND AUTOMATION — the endpoint n8n calls to act on this system.
 *
 * The mirror of `src/lib/events/bus.ts`: that publishes what happened here, this
 * accepts what a workflow decided elsewhere. A missed-call flow creates the
 * lead, a Google Calendar flow books the visit, a follow-up flow queues the
 * WhatsApp reply — all without an interactive session.
 *
 * Which is exactly why the authentication has to be right. This path is listed
 * in SELF_AUTHENTICATING in `src/middleware.ts`, so the session gate does not
 * run and the shared secret below is the *only* thing standing between the
 * public internet and a write to the CRM.
 */

/** Every action this endpoint will perform, named in the 400 for an unknown one. */
const ACTIONS = ["create_lead", "book_appointment", "send_message", "post_result"] as const;
type Action = (typeof ACTIONS)[number];

const LEAD_SOURCES: LeadSource[] = [
  "instagram", "facebook", "whatsapp", "meta_ads", "google_ads",
  "portal_99acres", "portal_magicbricks", "portal_housing",
  "referral", "broker", "walk_in", "website",
];

const APPOINTMENT_CHANNELS: AppointmentChannel[] = [
  "whatsapp", "phone", "walk_in", "website", "instagram", "staff",
];

/** Recorded as the author of anything this endpoint creates. */
const ACTOR = "n8n";

/**
 * Constant-time shared-secret check, following `requireWorkerSecret` in
 * src/lib/auth/session.ts.
 *
 * Two properties are load-bearing:
 *
 *  - FAIL CLOSED when N8N_WEBHOOK_SECRET is unset. Returning "allowed" for an
 *    unconfigured deployment is how a staging box ends up as an unauthenticated
 *    write API for whoever guesses the path — the same defect the WhatsApp
 *    webhook was fixed for.
 *  - Constant-time compare. A `===` on a secret returns faster the earlier it
 *    diverges, which recovers the secret one character at a time.
 *
 * The secret is read from a header only, never a query parameter: query strings
 * are written to access logs, proxy logs and browser history.
 */
function requireN8nSecret(req: Request): void {
  const expected = process.env.N8N_WEBHOOK_SECRET;
  if (!expected) throw new AuthError("The n8n webhook is not configured.", 503);
  const presented = req.headers.get("x-n8n-secret") ?? "";
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AuthError("Invalid webhook credentials.", 401);
  }
}

interface Body {
  action?: unknown;
  idempotencyKey?: unknown;
  payload?: unknown;
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

type ActionResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string; status: number };

/** create_lead — name, phone, source, notes? */
function createLead(p: Record<string, unknown>): ActionResult {
  const name = str(p.name, 120);
  const phone = normalisePhone(str(p.phone, 40));
  const source = str(p.source, 40);

  if (!name) return { ok: false, error: "A lead needs a name.", status: 400 };
  // Same floor the booking engine uses: a lead with no reachable number is a
  // row nobody can act on, and silently accepting it hides the broken workflow.
  if (phone.replace(/\D/g, "").length < 7) {
    return { ok: false, error: "A reachable phone number is required.", status: 400 };
  }
  if (!LEAD_SOURCES.includes(source as LeadSource)) {
    return { ok: false, error: `Unknown source. Use one of: ${LEAD_SOURCES.join(", ")}.`, status: 400 };
  }

  const db = read();
  const brandId = resolveBrandId(db, str(p.brandId, 60) || null);
  if (!brandId) return { ok: false, error: "No brand is configured to attach the lead to.", status: 409 };

  const now = new Date().toISOString();
  const lead: Lead = {
    id: uid("lead"),
    brandId,
    name,
    phone,
    city: "",
    status: "new",
    budgetMin: 0,
    budgetMax: 0,
    source: source as LeadSource,
    projectInterest: "",
    unitType: "",
    assignedTo: "Unassigned",
    score: 0,
    isHNWI: false,
    kycStatus: "not_started",
    notes: str(p.notes, 2000) || undefined,
    createdAt: now,
    updatedAt: now,
    tags: [],
  };
  lead.score = scoreLead(lead);

  mutate((d) => void d.leads.push(lead));
  logActivity(brandId, "crm", `New lead captured via n8n: ${lead.name}`, ACTOR);
  // The lead.created event is *not* emitted from here. n8n asked for this write,
  // so publishing it back would hand the same workflow its own action as a new
  // trigger — the standard way an automation pair turns into a loop.
  return { ok: true, data: { lead } };
}

/** book_appointment — everything real is delegated to the booking engine. */
function bookAppointment(p: Record<string, unknown>): ActionResult {
  const db = read();
  const brandId = resolveBrandId(db, str(p.brandId, 60) || null);
  if (!brandId) return { ok: false, error: "No brand is configured to book against.", status: 409 };

  const channel = str(p.channel, 20) || "website";
  if (!APPOINTMENT_CHANNELS.includes(channel as AppointmentChannel)) {
    return { ok: false, error: `Unknown channel. Use one of: ${APPOINTMENT_CHANNELS.join(", ")}.`, status: 400 };
  }

  // book() re-derives availability at write time, refuses a slot that has gone,
  // dedupes a double submit and keeps the lead's siteVisitAt in step. None of
  // that is re-implemented here — an automation must not be able to write an
  // appointment the UI could not.
  const result = book({
    brandId,
    startsAt: str(p.startsAt, 40),
    customerName: str(p.customerName, 120),
    customerPhone: str(p.customerPhone, 40),
    customerEmail: str(p.customerEmail, 200) || undefined,
    leadId: str(p.leadId, 60) || undefined,
    contactId: str(p.contactId, 60) || undefined,
    projectId: str(p.projectId, 60) || undefined,
    channel: channel as AppointmentChannel,
    notes: str(p.notes, 1000) || undefined,
    assignedTo: str(p.assignedTo, 120) || undefined,
    createdBy: ACTOR,
  });

  if (!result.ok || !result.appointment) {
    // 409, not 400: the request was well formed and the slot was taken. The
    // alternatives let the workflow offer the customer another time instead of
    // dropping the enquiry.
    return { ok: false, error: result.error ?? "The appointment could not be booked.", status: 409 };
  }
  logActivity(brandId, "appointments", `Site visit booked via n8n for ${result.appointment.customerName}`, ACTOR);
  return { ok: true, data: { appointment: result.appointment } };
}

/**
 * send_message — queue a WhatsApp reply against an existing conversation.
 *
 * Queued as a draft rather than delivered. A shared secret in an n8n credential
 * store is a lower bar than a staff session, and this action addresses a real
 * customer: handing it direct send would mean anyone holding that one secret
 * could write arbitrary text to any buyer under the company's number. The draft
 * lands in the inbox and a person releases it through /api/whatsapp/send, which
 * is where the 24-hour service-window rules already live.
 */
function sendMessage(p: Record<string, unknown>): ActionResult {
  const conversationId = str(p.conversationId, 120);
  const text = str(p.text, 4000);
  if (!conversationId) return { ok: false, error: "A conversationId is required.", status: 400 };
  if (!text) return { ok: false, error: "A message body is required.", status: 400 };

  const conv = read().conversations.find((c) => c.id === conversationId);
  if (!conv) return { ok: false, error: "That conversation does not exist.", status: 404 };

  // Refuse now rather than at send time. `authorId` is the wa_id recorded from
  // the signature-verified webhook body; a conversation without one has no
  // address anybody is willing to reply to, so queueing a draft against it just
  // moves the dead end to a staff member's screen.
  if (!/^\+?\d{7,20}$/.test((conv.authorId ?? "").replace(/[^\d+]/g, ""))) {
    return { ok: false, error: "That conversation has no verified sender id to reply to.", status: 409 };
  }

  mutate((d) => {
    const c = d.conversations.find((x) => x.id === conversationId);
    if (c) c.draftReply = text;
  });
  logActivity(conv.brandId, "inbox", `n8n queued a reply for ${conv.author}`, ACTOR);
  return { ok: true, data: { conversationId, queued: true, awaiting: "staff release" } };
}

/**
 * post_result — the video workflow reporting one platform's outcome.
 *
 * The hand-off (`/api/automation/post-video`) only learns whether the form
 * *accepted* the upload; publishing happens minutes later inside the
 * workflow. This closes the loop: `submissionId` is the "Submission ID" hidden
 * field the app sent with the video, so the row can move to published/failed
 * per platform. No idempotency receipt is needed — a repeat overwrites the same
 * platform slot.
 */
function postResult(p: Record<string, unknown>): ActionResult {
  const submissionId = str(p.submissionId, 80);
  const platform = str(p.platform, 40);
  const status = str(p.status, 20);
  if (!submissionId) return { ok: false, error: "A submissionId is required.", status: 400 };
  if (!isN8nPlatform(platform)) {
    return { ok: false, error: `Unknown platform "${platform}". Use the label from the form's platform checkboxes.`, status: 400 };
  }
  if (status !== "published" && status !== "failed") {
    return { ok: false, error: `status must be "published" or "failed".`, status: 400 };
  }
  const externalUrl = str(p.externalUrl, 500);
  if (externalUrl && !/^https:\/\//.test(externalUrl)) {
    return { ok: false, error: "externalUrl must be an https URL.", status: 400 };
  }
  const outcome = recordPlatformResult(submissionId, {
    platform,
    status,
    externalUrl: externalUrl || undefined,
    error: str(p.error, 1000) || undefined,
  });
  if (!outcome.ok) return outcome;

  const brandId = resolveBrandId(read(), null);
  if (brandId) {
    logActivity(
      brandId,
      "integrations",
      status === "published"
        ? `"${outcome.submission.title}" published to ${platform}`
        : `"${outcome.submission.title}" failed on ${platform}: ${str(p.error, 200) || "no reason given"}`,
      ACTOR,
    );
  }
  return { ok: true, data: { submission: outcome.submission } };
}

/* -------------------------------------------------------------------------- */

export async function POST(req: Request) {
  try {
    // Before the secret check, and keyed on the caller rather than the secret:
    // an unauthenticated flood should cost the attacker, not this process. The
    // window is generous because a legitimate n8n batch is bursty.
    const limit = rateLimit(`n8n:${clientKey(req)}`, { max: 120, windowSeconds: 60, lockoutSeconds: 300 });
    if (!limit.allowed) {
      return apiFail(`Too many requests. Retry in ${limit.retryAfterSeconds ?? 60}s.`, 429);
    }

    requireN8nSecret(req);

    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return apiFail("The request body must be JSON.", 400);
    }

    const action = str(body.action, 40);
    if (!(ACTIONS as readonly string[]).includes(action)) {
      return apiFail(
        action
          ? `Unknown action "${action}". Supported actions are: ${ACTIONS.join(", ")}.`
          : `An action is required. Supported actions are: ${ACTIONS.join(", ")}.`,
        400,
      );
    }

    const idempotencyKey = str(body.idempotencyKey, 200);
    if (idempotencyKey) {
      // n8n retries a failed workflow run from the start, so the same booking
      // arrives twice whenever the *next* node errored. Replaying the first
      // answer keeps that from becoming two site visits.
      const seen = replayReceipt(idempotencyKey);
      if (seen) {
        // A key is bound to the action it first performed. Replaying a lead
        // as the answer to a booking would tell the workflow its visit is
        // confirmed when nothing was booked; a 409 says "pick a new key".
        if (seen.action !== action) {
          return apiFail(`idempotencyKey was already used for "${seen.action}"; use a new key for "${action}".`, 409);
        }
        return apiOk({ action, ...seen.result, idempotent: true, firstSeenAt: seen.at });
      }
    }

    const payload =
      body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
        ? (body.payload as Record<string, unknown>)
        : {};

    let result: ActionResult;
    switch (action as Action) {
      case "create_lead":
        result = createLead(payload);
        break;
      case "book_appointment":
        result = bookAppointment(payload);
        break;
      case "send_message":
        result = sendMessage(payload);
        break;
      case "post_result":
        result = postResult(payload);
        break;
    }

    if (!result.ok) return apiFail(result.error, result.status);

    if (idempotencyKey) rememberReceipt(idempotencyKey, action, result.data);
    return apiOk({ action, ...result.data });
  } catch (e) {
    return apiError(e);
  }
}
