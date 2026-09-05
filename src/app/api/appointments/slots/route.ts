import { read, resolveBrandId } from "@/lib/db";
import { requirePermission } from "@/lib/auth/session";
import { apiError, apiFail, apiOk } from "@/lib/auth/http";
import { slots } from "@/lib/appointments/engine";

/**
 * BOOKABLE SLOTS
 *
 * What the booking form draws from. Read-only and derived: nothing here is
 * stored, so a slot list is always as fresh as the moment it was asked for —
 * which is also why `book()` re-checks availability rather than trusting that
 * the caller's copy of this list is still true.
 */

/** A month of slots is already more than any form renders; 60 days is the ceiling. */
const MAX_DAYS = 60;
const DEFAULT_DAYS = 14;

export async function GET(req: Request) {
  try {
    await requirePermission("customers.read");

    const url = new URL(req.url);
    const requested = url.searchParams.get("brandId") ?? url.searchParams.get("brand");
    const db = read();
    const brandId = resolveBrandId(db, requested);
    if (!brandId) return apiFail("No brand is configured yet, so there are no slots.", 400);
    if (requested && requested !== brandId) return apiFail(`No brand ${requested} exists.`, 404);

    const fromParam = url.searchParams.get("from");
    const from = fromParam ? new Date(fromParam) : new Date();
    if (Number.isNaN(from.getTime())) return apiFail("`from` is not a valid date.", 400);

    const daysParam = url.searchParams.get("days");
    let days = DEFAULT_DAYS;
    if (daysParam !== null) {
      const parsed = Number(daysParam);
      if (!Number.isFinite(parsed) || parsed < 1) return apiFail("`days` must be a positive number.", 400);
      // Clamped rather than rejected: an over-large window is a caller asking
      // for everything, not an error, and the cap keeps one request from walking
      // years of the calendar.
      days = Math.min(Math.floor(parsed), MAX_DAYS);
    }

    const exclude = url.searchParams.get("excludeAppointmentId") ?? undefined;

    return apiOk({
      brandId,
      from: from.toISOString(),
      days,
      slots: slots(brandId, from.toISOString(), days, exclude),
    });
  } catch (e) {
    return apiError(e);
  }
}
