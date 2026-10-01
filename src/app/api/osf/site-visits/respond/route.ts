import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { actorLabel, getSession } from "@/lib/auth/session";
import { guard } from "@/lib/auth/guard";
import { readPost, safePath } from "@/lib/osf/form-post";
import { confirmSiteVisit, offerAlternativeSlot, wallClockToUtc } from "@/lib/osf/site-visit-booking";
import { loadSettings } from "@/lib/villa/settings";
import { DEFAULT_BRAND_ID } from "@/lib/bootstrap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Answering a site-visit request.
 *
 * `customers.write`, because both outcomes send the customer a WhatsApp
 * message — this is contact, not a record edit.
 *
 * Every answer needs a time. Confirming without one would leave an appointment
 * with no slot; offering an alternative without one is a refusal with nothing
 * to agree to, which is the thing this flow exists to avoid.
 */

const PAGE = "/inbox/whatsapp/sales/site-visits";

export async function POST(request: Request) {
  const denied = await guard("customers.write");
  if (denied) return denied;

  const body = await readPost(request);
  const visitId = (body.get("visitId") ?? "").trim();
  const action = (body.get("action") ?? "").trim();
  const when = (body.get("when") ?? "").trim();
  const note = (body.get("note") ?? "").trim();
  const next = safePath(body.get("next"), PAGE);

  const fail = (error: string) => NextResponse.json({ ok: false, error }, { status: 400 });

  if (!visitId) return fail("No visit was named.");
  if (action !== "confirm" && action !== "alternative") return fail("Unknown action.");
  if (!when) {
    return fail(
      action === "confirm"
        ? "Pick the time you are confirming."
        : "Suggest a time — telling someone no without offering an alternative leaves them nowhere to go.",
    );
  }

  // A datetime-local field sends "2026-10-05T18:00" with no offset, and a
  // date-time with no offset is the RUNTIME's local time — UTC on the server,
  // Asia/Kolkata for the business. Parsing it with `new Date` booked 6pm as
  // 11:30pm and said so to the customer, with no error anywhere.
  const settings = await loadSettings(DEFAULT_BRAND_ID);
  const at = wallClockToUtc(when, settings.callingTimeZone);
  if (!at) return fail("That is not a time we could read.");

  const actor = actorLabel(await getSession());
  const result =
    action === "confirm"
      ? await confirmSiteVisit({ visitId, scheduledAtIso: at.toISOString(), actor })
      : await offerAlternativeSlot({ visitId, proposedAtIso: at.toISOString(), actor, note });

  if (!result.ok) return fail(result.error ?? "That did not work.");

  revalidatePath(PAGE);

  const accepts = request.headers.get("accept") ?? "";
  if (accepts.includes("application/json")) return NextResponse.json({ ...result, ok: true });

  // The desk needs to know if the customer was not actually reached — the
  // diary moved either way, so silence here would be misleading.
  const url = new URL(next, "http://local.invalid");
  url.searchParams.set("visit", action === "confirm" ? "confirmed" : "suggested");
  if (!result.messaged) url.searchParams.set("unsent", "1");
  return NextResponse.redirect(new URL(`${url.pathname}${url.search}`, request.url), { status: 303 });
}
