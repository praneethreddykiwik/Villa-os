import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { readPost, respond, safePath, type ActionResult } from "@/lib/osf/form-post";
import {
  addPayment,
  createBooking,
  createTeamMember,
  recordVisitOutcome,
  scheduleSiteVisit,
  setPaymentStatus,
  toggleMemberActive,
  updateBookingStatus,
  updateSiteVisitStatus,
} from "@/lib/osf/sales";
import { guard } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every write behind the Sales section, keyed on an `action` field.
 *
 * The pages submit plain HTML forms so they work with no client JS, so the
 * default reply is a 303 back to the page with any failure on `?error=`.
 * A scripted caller (cron, the agent) can post JSON and get JSON instead —
 * see readPost/respond in lib/form-post.
 */
export async function POST(request: Request) {
  const denied = await guard("sales.write");
  if (denied) return denied;
  const body = await readPost(request);
  const action = body.get("action");

  /** A numeric form field, or null when blank. NaN is rejected by the callee. */
  const num = (name: string): number | null => {
    const raw = body.get(name);
    if (raw === undefined) return null;
    return Math.trunc(Number(raw));
  };

  const finish = (fallback: string, result: ActionResult) =>
    respond(request, body, safePath(body.get("next"), fallback), result);

  switch (action) {
    // ---------------------------------------------------------------- visits
    case "schedule-visit": {
      const result = await scheduleSiteVisit({
        leadId: body.get("leadId") ?? "",
        projectId: body.get("projectId") ?? null,
        assignedTo: body.get("assignedTo") ?? null,
        scheduledAtLocal: body.get("scheduledAt") ?? null,
        visitorCount: num("visitorCount"),
        visitType: body.get("visitType") ?? null,
        transportArranged: body.bool("transportArranged"),
        specialRequirements: body.get("specialRequirements") ?? null,
        notes: body.get("notes") ?? null,
      });
      if (result.ok) {
        revalidatePath("/inbox/whatsapp/sales/site-visits");
        revalidatePath("/inbox/whatsapp/crm/leads");
      }
      return finish("/inbox/whatsapp/sales/site-visits", result);
    }

    case "visit-status": {
      const result = await updateSiteVisitStatus(body.get("visitId") ?? "", body.get("status") ?? "");
      if (result.ok) revalidatePath("/inbox/whatsapp/sales/site-visits");
      return finish("/inbox/whatsapp/sales/site-visits", result);
    }

    case "visit-outcome": {
      const result = await recordVisitOutcome(
        body.get("visitId") ?? "",
        body.get("outcome"),
        body.get("feedback"),
      );
      if (result.ok) revalidatePath("/inbox/whatsapp/sales/site-visits");
      return finish("/inbox/whatsapp/sales/site-visits", result);
    }

    // -------------------------------------------------------------- bookings
    case "create-booking": {
      const result = await createBooking({
        leadId: body.get("leadId") ?? "",
        projectId: body.get("projectId") ?? null,
        villaTypeId: body.get("villaTypeId") ?? null,
        unitId: body.get("unitId") ?? null,
        valueInr: num("valueInr") ?? Number.NaN,
        tokenAmountInr: num("tokenAmountInr"),
        customerName: body.get("customerName") ?? null,
        assignedTo: body.get("assignedTo") ?? null,
        notes: body.get("notes") ?? null,
      });
      if (result.ok) {
        revalidatePath("/inbox/whatsapp/crm/leads");
      }
      // Both outcomes land on Site visits. The bookings screen this used to
      // fall back to on failure no longer exists, so a failed create sent the
      // desk to a 404 — the one moment they most need to see the error.
      return respond(request, body, "/inbox/whatsapp/sales/site-visits", result);
    }

    case "booking-status": {
      const bookingId = body.get("bookingId") ?? "";
      const result = await updateBookingStatus(bookingId, body.get("status") ?? "");
      if (result.ok) {
      }
      return finish("/inbox/whatsapp/sales/site-visits", result);
    }

    case "add-payment": {
      const bookingId = body.get("bookingId") ?? "";
      const result = await addPayment({
        bookingId,
        milestone: body.get("milestone") ?? "",
        amountInr: num("amountInr") ?? Number.NaN,
        dueDate: body.get("dueDate") ?? null,
        status: body.get("status"),
      });
      if (result.ok) {
      }
      return finish("/inbox/whatsapp/sales/site-visits", result);
    }

    case "payment-status": {
      const bookingId = body.get("bookingId") ?? "";
      const result = await setPaymentStatus(body.get("paymentId") ?? "", body.get("status") ?? "");
      if (result.ok) {
      }
      return finish("/inbox/whatsapp/sales/site-visits", result);
    }

    // ------------------------------------------------------------------ team
    case "add-member": {
      const result = await createTeamMember({
        name: body.get("name") ?? "",
        email: body.get("email") ?? null,
        phone: body.get("phone") ?? null,
        role: body.get("role") ?? null,
        department: body.get("department") ?? null,
        quotaInr: num("quotaInr"),
        languages: body.get("languages") ?? null,
        acceptsLeads: body.get("acceptsLeads") === undefined ? true : body.bool("acceptsLeads"),
      });
      if (result.ok) revalidatePath("/inbox/whatsapp/sales/site-visits");
      return finish("/inbox/whatsapp/sales/site-visits", result);
    }

    case "toggle-member": {
      const result = await toggleMemberActive(body.get("memberId") ?? "");
      if (result.ok) revalidatePath("/inbox/whatsapp/sales/site-visits");
      return finish("/inbox/whatsapp/sales/site-visits", result);
    }

    default:
      return NextResponse.json(
        {
          error:
            "action must be one of: schedule-visit, visit-status, visit-outcome, create-booking, booking-status, add-payment, payment-status, add-member, toggle-member",
        },
        { status: 400 },
      );
  }
}
