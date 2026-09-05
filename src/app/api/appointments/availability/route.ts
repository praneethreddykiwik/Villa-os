import { read, resolveBrandId } from "@/lib/db";
import { requirePermission } from "@/lib/auth/session";
import { apiError, apiFail, apiOk } from "@/lib/auth/http";
import { availabilityFor, saveAvailability } from "@/lib/appointments/engine";
import type { AvailabilityConfig } from "@/lib/appointments/types";

/**
 * OPENING HOURS AND CAPACITY
 *
 * This is the configuration every slot in the system is derived from, so it is
 * validated far harder than a normal settings write. The engine does arithmetic
 * on these numbers without re-checking them — `minutes("bogus")` is NaN and
 * silently yields a day with no slots, a `slotMinutes` of 0 loops forever, and a
 * `concurrentCapacity` of 500 quietly promises the site to five hundred buyers
 * at once. None of those surface as an error anywhere; they surface as a
 * calendar that is mysteriously wrong. Reject them at the door instead.
 *
 * Reading hours is a `customers.read` matter — the desk needs to know when the
 * site is open. Changing them is `workflows.manage`: it retroactively changes
 * what everybody else in the building can promise.
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Window { start: string; end: string }

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Bounded whole number, named so the message can say which field failed. */
function checkInt(v: unknown, field: string, min: number, max: number): string | null {
  if (typeof v !== "number" || !Number.isInteger(v)) return `\`${field}\` must be a whole number.`;
  if (v < min || v > max) return `\`${field}\` must be between ${min} and ${max}.`;
  return null;
}

function checkOpenHours(v: unknown): string | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return "`openHours` must be an object keyed by day number, 0 = Sunday … 6 = Saturday.";
  }
  for (const [day, windows] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[0-6]$/.test(day)) return `\`openHours\` has key ${day}; days are 0 to 6.`;
    if (!Array.isArray(windows)) return `\`openHours.${day}\` must be an array of { start, end } windows.`;
    for (const w of windows as unknown[]) {
      if (typeof w !== "object" || w === null) return `\`openHours.${day}\` contains something that is not a window.`;
      const { start, end } = w as { start?: unknown; end?: unknown };
      if (typeof start !== "string" || !HHMM.test(start)) {
        return `\`openHours.${day}\` has start ${JSON.stringify(start)}; expected "HH:MM" on a 24-hour clock.`;
      }
      if (typeof end !== "string" || !HHMM.test(end)) {
        return `\`openHours.${day}\` has end ${JSON.stringify(end)}; expected "HH:MM" on a 24-hour clock.`;
      }
      // A window that ends before it starts produces no slots at all rather than
      // an error, which reads to an operator as "the booking form is broken".
      if (minutes(start) >= minutes(end)) {
        return `\`openHours.${day}\` window ${start}–${end} must start before it ends.`;
      }
    }
  }
  return null;
}

function checkBlackouts(v: unknown): string | null {
  if (!Array.isArray(v)) return "`blackoutDates` must be an array of YYYY-MM-DD dates.";
  for (const d of v as unknown[]) {
    if (typeof d !== "string" || !ISO_DATE.test(d)) {
      return `\`blackoutDates\` contains ${JSON.stringify(d)}; expected YYYY-MM-DD.`;
    }
    // Shape is not existence: 2026-02-30 matches the pattern and is not a day.
    // Round-tripping through Date catches it, because the overflow renames it.
    const parsed = new Date(`${d}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== d) {
      return `\`blackoutDates\` contains ${d}, which is not a real date.`;
    }
  }
  return null;
}

function checkTimezone(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return "`timezone` must be an IANA zone name such as Asia/Kolkata.";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: v });
    return null;
  } catch {
    return `\`timezone\` ${v} is not a zone this runtime knows.`;
  }
}

export async function GET(req: Request) {
  try {
    await requirePermission("customers.read");

    const params = new URL(req.url).searchParams;
    const requested = params.get("brandId") ?? params.get("brand");
    const brandId = resolveBrandId(read(), requested);
    if (!brandId) return apiFail("No brand is configured yet.", 400);
    if (requested && requested !== brandId) return apiFail(`No brand ${requested} exists.`, 404);

    return apiOk({ availability: availabilityFor(brandId) });
  } catch (e) {
    return apiError(e);
  }
}

export async function PATCH(req: Request) {
  try {
    await requirePermission("workflows.manage");

    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await req.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return apiFail("Send a JSON object body.", 400);
      body = parsed as Record<string, unknown>;
    } catch {
      return apiFail("Send a JSON object body.", 400);
    }

    const requested = typeof body.brandId === "string" && body.brandId ? body.brandId : null;
    const brandId = resolveBrandId(read(), requested);
    if (!brandId) return apiFail("No brand is configured yet.", 400);
    if (requested && requested !== brandId) return apiFail(`No brand ${requested} exists.`, 404);

    // A partial patch on purpose: an operator changing the capacity should not
    // have to resend every opening hour, and a client that forgets one field
    // should not silently close the site on Sundays.
    const current = availabilityFor(brandId);
    const next: AvailabilityConfig = { ...current, brandId };

    if ("timezone" in body) {
      const bad = checkTimezone(body.timezone);
      if (bad) return apiFail(bad, 400);
      next.timezone = body.timezone as string;
    }
    if ("slotMinutes" in body) {
      // Floor: shorter than a quarter of an hour is not a site visit. Ceiling:
      // four hours, past which a "slot" is a day and capacity stops meaning
      // anything.
      const bad = checkInt(body.slotMinutes, "slotMinutes", 15, 240);
      if (bad) return apiFail(bad, 400);
      next.slotMinutes = body.slotMinutes as number;
    }
    if ("concurrentCapacity" in body) {
      const bad = checkInt(body.concurrentCapacity, "concurrentCapacity", 1, 50);
      if (bad) return apiFail(bad, 400);
      next.concurrentCapacity = body.concurrentCapacity as number;
    }
    if ("minNoticeHours" in body) {
      // A week of required notice is already extreme; more than that is a typo.
      const bad = checkInt(body.minNoticeHours, "minNoticeHours", 0, 168);
      if (bad) return apiFail(bad, 400);
      next.minNoticeHours = body.minNoticeHours as number;
    }
    if ("maxAdvanceDays" in body) {
      const bad = checkInt(body.maxAdvanceDays, "maxAdvanceDays", 1, 365);
      if (bad) return apiFail(bad, 400);
      next.maxAdvanceDays = body.maxAdvanceDays as number;
    }
    if ("openHours" in body) {
      const bad = checkOpenHours(body.openHours);
      if (bad) return apiFail(bad, 400);
      const source = body.openHours as Record<string, Window[]>;
      const hours: Record<number, Window[]> = {};
      for (const [day, windows] of Object.entries(source)) {
        hours[Number(day)] = windows.map((w) => ({ start: w.start, end: w.end }));
      }
      next.openHours = hours;
    }
    if ("blackoutDates" in body) {
      const bad = checkBlackouts(body.blackoutDates);
      if (bad) return apiFail(bad, 400);
      // De-duplicated and sorted, so the stored list stays diffable and the
      // engine's `includes` check does not walk repeats.
      next.blackoutDates = [...new Set(body.blackoutDates as string[])].sort();
    }

    return apiOk({ availability: saveAvailability(next) });
  } catch (e) {
    return apiError(e);
  }
}
