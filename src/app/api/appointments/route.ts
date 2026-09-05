import { NextResponse } from "next/server";
import { read, resolveBrandId } from "@/lib/db";
import { actorLabel, requirePermission } from "@/lib/auth/session";
import { apiError, apiFail, apiOk } from "@/lib/auth/http";
import { rateLimit } from "@/lib/ops/ratelimit";
import { book, listAppointments, transition, type BookResult } from "@/lib/appointments/engine";
import type { AppointmentChannel, AppointmentStatus } from "@/lib/appointments/types";

/**
 * SITE VISIT APPOINTMENTS — HTTP surface.
 *
 * The engine owns every rule (opening hours, capacity, legal transitions); this
 * layer only decides who may call it, what a malformed request looks like, and
 * which status code a refusal deserves. Nothing here re-implements a booking
 * rule, because a second copy of "is this slot free" is a second answer.
 *
 * The one thing this layer does add is the shape of a refusal. When the engine
 * turns a booking down because the slot went while the caller was reading it,
 * it hands back alternatives — and those have to reach the client, because the
 * desk usually still has the buyer on the phone.
 */

const STATUSES: AppointmentStatus[] = [
  "requested", "confirmed", "rescheduled", "completed", "no_show", "cancelled",
];

const CHANNELS: AppointmentChannel[] = [
  "whatsapp", "phone", "walk_in", "website", "instagram", "staff",
];

/**
 * Statuses a caller may ask for. "requested" is missing on purpose: it is where
 * an appointment starts, never somewhere it is moved to, and the engine's
 * transition table has no path into it.
 */
const TARGETS: AppointmentStatus[] = ["confirmed", "rescheduled", "completed", "no_show", "cancelled"];

/** Trimmed string, or "" for anything that is not a string. */
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
 * A refusal that carries the engine's suggested times.
 *
 * `apiFail` takes a message only, and here the alternatives are the substance
 * of the response rather than decoration — a 409 with no other time to offer
 * sends the caller back to the slots endpoint for information the engine has
 * already computed. The envelope is otherwise identical, so clients that branch
 * on `ok` keep working.
 */
function refuse(result: BookResult, status: number): NextResponse {
  const body: Record<string, unknown> = { ok: false, error: result.error ?? "That could not be saved." };
  if (result.alternatives) body.alternatives = result.alternatives;
  return NextResponse.json(body, { status });
}

/**
 * Alternatives are only ever attached when the requested time is gone, so their
 * presence is exactly the "conflict, try again differently" case. Everything
 * else the engine refuses is bad input the caller must correct.
 */
function statusFor(result: BookResult): number {
  return result.alternatives ? 409 : 400;
}

/**
 * Resolve the brand, distinguishing "not specified" from "specified but wrong".
 *
 * `resolveBrandId` silently falls back to the first brand for an unknown id,
 * which is right for a dashboard filter and wrong here: booking a viewing
 * against a project the caller did not name is worse than an error.
 */
function brandOr(requested: string | null): { brandId: string } | { error: NextResponse } {
  const db = read();
  const brandId = resolveBrandId(db, requested);
  if (!brandId) return { error: apiFail("No brand is configured yet, so there is nothing to book against.", 400) };
  if (requested && requested !== brandId) return { error: apiFail(`No brand ${requested} exists.`, 404) };
  return { brandId };
}

/** Booked visits in a window. */
export async function GET(req: Request) {
  try {
    await requirePermission("customers.read");

    const url = new URL(req.url);
    const resolved = brandOr(url.searchParams.get("brandId") ?? url.searchParams.get("brand"));
    if ("error" in resolved) return resolved.error;

    // The store compares `startsAt` as a string, and every stored value is a
    // UTC ISO instant. A caller sending "+05:30" would sort correctly by clock
    // but wrongly by lexicographic order, so both bounds are normalised first.
    const bounds: { from?: string; to?: string } = {};
    for (const key of ["from", "to"] as const) {
      const raw = url.searchParams.get(key);
      if (!raw) continue;
      const when = new Date(raw);
      if (Number.isNaN(when.getTime())) return apiFail(`\`${key}\` is not a valid date and time.`, 400);
      bounds[key] = when.toISOString();
    }

    const statusParam = url.searchParams.get("status");
    let status: AppointmentStatus[] | undefined;
    if (statusParam) {
      const wanted = statusParam.split(",").map((s) => s.trim()).filter(Boolean);
      const unknown = wanted.find((s) => !STATUSES.includes(s as AppointmentStatus));
      if (unknown) return apiFail(`\`status\` contains ${unknown}; expected one of ${STATUSES.join(", ")}.`, 400);
      status = wanted as AppointmentStatus[];
    }

    const appointments = listAppointments(resolved.brandId, { ...bounds, status });
    return apiOk({ brandId: resolved.brandId, appointments });
  } catch (e) {
    return apiError(e);
  }
}

/** Book a slot. */
export async function POST(req: Request) {
  try {
    const session = await requirePermission("customers.write");

    // Per-account, because a booking writes a customer record and holds a slot
    // that a real buyer then cannot have. A stuck retry loop should cost the
    // account its own budget rather than the day's capacity.
    const limit = rateLimit(`appointments:book:${session.userId}`, {
      max: 40,
      windowSeconds: 300,
      lockoutSeconds: 300,
    });
    if (!limit.allowed) {
      return apiFail(`Too many booking attempts. Try again in ${limit.retryAfterSeconds ?? 300} seconds.`, 429);
    }

    const body = await jsonBody(req);
    if (!body) return apiFail("Send a JSON object body.", 400);

    const resolved = brandOr(str(body.brandId) || null);
    if ("error" in resolved) return resolved.error;

    const startsAt = str(body.startsAt);
    if (!startsAt) return apiFail("`startsAt` is required.", 400);
    const customerName = str(body.customerName);
    if (!customerName) return apiFail("`customerName` is required.", 400);
    const customerPhone = str(body.customerPhone);
    if (!customerPhone) return apiFail("`customerPhone` is required — the confirmation goes there.", 400);

    const channel = str(body.channel);
    if (!CHANNELS.includes(channel as AppointmentChannel)) {
      return apiFail(`\`channel\` must be one of ${CHANNELS.join(", ")}.`, 400);
    }

    // book() folds a double submit onto the booking that already exists. Knowing
    // which ids were present beforehand is the only way to tell that apart from
    // a genuine creation without re-deriving the engine's dedupe rule here, and
    // a retrying client should not be told it created a second visit.
    const existing = new Set((read().appointments ?? []).map((a) => a.id));

    const result = book({
      brandId: resolved.brandId,
      startsAt,
      customerName,
      customerPhone,
      customerEmail: str(body.customerEmail) || undefined,
      leadId: str(body.leadId) || undefined,
      contactId: str(body.contactId) || undefined,
      projectId: str(body.projectId) || undefined,
      channel: channel as AppointmentChannel,
      notes: str(body.notes) || undefined,
      assignedTo: str(body.assignedTo) || undefined,
      createdBy: actorLabel(session),
    });

    if (!result.ok || !result.appointment) return refuse(result, statusFor(result));

    const created = !existing.has(result.appointment.id);
    return apiOk({ appointment: result.appointment, created }, created ? 201 : 200);
  } catch (e) {
    return apiError(e);
  }
}

/** Confirm, reschedule, complete, mark a no-show, or cancel. */
export async function PATCH(req: Request) {
  try {
    const session = await requirePermission("customers.write");

    const limit = rateLimit(`appointments:transition:${session.userId}`, { max: 120, windowSeconds: 300 });
    if (!limit.allowed) {
      return apiFail(`Too many changes. Try again in ${limit.retryAfterSeconds ?? 300} seconds.`, 429);
    }

    const body = await jsonBody(req);
    if (!body) return apiFail("Send a JSON object body.", 400);

    const id = str(body.id);
    if (!id) return apiFail("`id` is required.", 400);

    const to = str(body.to);
    if (!TARGETS.includes(to as AppointmentStatus)) {
      return apiFail(`\`to\` must be one of ${TARGETS.join(", ")}.`, 400);
    }

    const result = transition({
      id,
      to: to as AppointmentStatus,
      by: actorLabel(session),
      reason: str(body.reason) || undefined,
      newStartsAt: str(body.newStartsAt) || undefined,
    });

    if (!result.ok || !result.appointment) {
      // A missing appointment is neither a conflict nor malformed input: the
      // caller is holding an id for something that no longer exists, and 404 is
      // the only answer that tells them so.
      if (!result.alternatives && !read().appointments?.some((a) => a.id === id)) {
        return refuse(result, 404);
      }
      return refuse(result, statusFor(result));
    }

    return apiOk({ appointment: result.appointment });
  } catch (e) {
    return apiError(e);
  }
}
