import { db } from "./supabase";
import { logActivity } from "./activities";
import { sendPlainText } from "./whatsapp/outbound";
import { loadSettings } from "../villa/settings";
import { DEFAULT_BRAND_ID } from "../bootstrap";

/**
 * ANSWERING A SITE-VISIT REQUEST.
 *
 * A customer asks the agent for a slot — "Sunday evening, around six". That
 * lands here as a visit with status `requested` and a preferred date and time.
 * Somebody who knows the diary then either confirms it or offers a different
 * time, and the customer hears back either way.
 *
 * WHY THERE IS NO "REJECT"
 *
 * From the business's side an unavailable slot is a rejection. From the
 * customer's side it is a scheduling detail, and being told they were rejected
 * reads as being turned away by a company they were about to buy a house from.
 * So there is `confirm` and there is `offerAlternative`, and the second one
 * always carries a concrete new time — never a refusal on its own.
 *
 * Neither function throws. A visit that was confirmed in the database but whose
 * WhatsApp failed is a message to resend, not a booking to lose, so the status
 * change is committed first and the send is reported separately.
 */

/**
 * The states an answer may act on.
 *
 * Confirming a completed visit, or dragging a cancelled one back to
 * `requested`, are both reachable by a second click on a stale page.
 */
const ANSWERABLE = ["requested", "scheduled"] as const;

export interface RespondResult {
  ok: boolean;
  /** What went wrong, in words the desk can act on. */
  error?: string;
  /** False when the visit moved but the customer was not reached. */
  messaged: boolean;
}

/**
 * The UTC instant of a wall-clock time in the business's own zone.
 *
 * A `datetime-local` field sends "2026-10-05T18:00" with no offset, and
 * ECMA-262 says a date-time with no offset is the RUNTIME's local time. The
 * server runs in UTC; the business runs in Asia/Kolkata. So `new Date(when)`
 * read 6pm as 6pm UTC and stored an appointment for 11:30pm IST — then told
 * the customer so, in a WhatsApp message, in their own time zone.
 *
 * Nothing flagged it: the string is well-formed, so no parse error, and the
 * desk's own list rendered the same wrong hour back at them.
 */
export function wallClockToUtc(wallClock: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(wallClock.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);

  // Date.UTC carries out-of-range parts instead of refusing them: month 13
  // becomes January of the next year, day 45 rolls into the following month.
  // So "2026-13-45T99:99" parsed cleanly into 17 February 2027 — a date
  // nobody chose, for a visit somebody would then be told about.
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;

  // Read the wall-clock fields as if they were UTC, then subtract whatever
  // the zone's offset actually is at that moment.
  const asIfUtc = Date.UTC(y, mo - 1, d, h, mi);
  let ts = asIfUtc - zoneOffsetMs(new Date(asIfUtc), timeZone);

  // One correction pass: near a DST change the offset at the guessed instant
  // can differ from the offset at the real one. India does not observe DST,
  // but this must not be wrong for a business that does.
  const corrected = asIfUtc - zoneOffsetMs(new Date(ts), timeZone);
  if (corrected !== ts) ts = corrected;

  const out = new Date(ts);
  if (Number.isNaN(out.getTime())) return null;

  // 31 April and 30 February pass the range check above and roll forward, so
  // confirm the instant really lands on the day that was asked for.
  const back = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(out);
  const wanted = `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return back === wanted ? out : null;
}

/** How far ahead of UTC `timeZone` is at `at`, in milliseconds. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const f = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return Date.UTC(f("year"), f("month") - 1, f("day"), f("hour"), f("minute"), f("second")) - at.getTime();
}

/** The date part of an instant, in the business's zone, as YYYY-MM-DD. */
export function zonedDatePart(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const f = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${f("year")}-${f("month")}-${f("day")}`;
}

/** A date the customer would recognise: "Sunday 5 October at 6:00 pm". */
export async function humanSlot(iso: string): Promise<string> {
  const settings = await loadSettings(DEFAULT_BRAND_ID);
  const when = new Date(iso);
  const date = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: settings.callingTimeZone,
  }).format(when);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: settings.callingTimeZone,
  }).format(when);
  return `${date} at ${time}`;
}

interface VisitContext {
  id: string;
  leadId: string;
  phone: string;
  name: string | null;
  project: string | null;
}

async function loadVisit(id: string): Promise<VisitContext | null> {
  const { data } = await db()
    .from("villa_site_visits")
    .select("id, lead_id, villa_leads(name, phone), villa_projects(name)")
    .eq("id", id)
    .maybeSingle();
  if (!data) return null;

  // PostgREST returns an embedded row as an object or a one-element array
  // depending on how it infers the relationship; both shapes appear here.
  const lead = Array.isArray(data.villa_leads) ? data.villa_leads[0] : data.villa_leads;
  const project = Array.isArray(data.villa_projects) ? data.villa_projects[0] : data.villa_projects;
  if (!lead?.phone) return null;

  return {
    id: data.id as string,
    leadId: data.lead_id as string,
    phone: lead.phone as string,
    name: (lead.name as string | null) ?? null,
    project: (project?.name as string | null) ?? null,
  };
}

function greeting(name: string | null): string {
  return name?.trim() ? `Hi ${name.trim().split(/\s+/)[0]}` : "Hi there";
}

/**
 * The slot is available: hold it and tell them so.
 *
 * `scheduled_at` is what the rest of the app reads; `preferred_*` is only ever
 * what was asked for, so confirming writes the real appointment time rather
 * than leaving the two to disagree.
 */
export async function confirmSiteVisit(input: {
  visitId: string;
  /** The agreed time. Normally the slot they asked for. */
  scheduledAtIso: string;
  actor: string;
}): Promise<RespondResult> {
  const visit = await loadVisit(input.visitId);
  if (!visit) return { ok: false, error: "That visit no longer exists, or the lead has no phone number.", messaged: false };

  const { data: changed, error } = await db()
    .from("villa_site_visits")
    .update({ status: "confirmed", scheduled_at: input.scheduledAtIso })
    .eq("id", input.visitId)
    .in("status", ANSWERABLE)
    .select("id");
  if (error) return { ok: false, error: "The visit could not be confirmed.", messaged: false };
  // An UPDATE that matched nothing returns no error. Without this check the
  // customer was told "your visit is confirmed" for a row never written —
  // because somebody else answered it first, or it was cancelled meanwhile.
  if (!changed || changed.length === 0) {
    return { ok: false, error: "That request has already been answered — reload to see where it stands.", messaged: false };
  }

  const slot = await humanSlot(input.scheduledAtIso);
  const place = visit.project ? ` at ${visit.project}` : "";
  const body =
    `${greeting(visit.name)}, your site visit${place} is confirmed for ${slot}. ` +
    `We look forward to showing you around. If anything changes, just reply here and we'll rearrange it.`;

  let messaged = true;
  try {
    await sendPlainText(visit.phone, body);
  } catch {
    messaged = false;
  }

  await logActivity({
    leadId: visit.leadId,
    type: "site_visit_confirmed",
    channel: "whatsapp",
    actorName: input.actor,
    description: `Site visit confirmed for ${slot}.`,
    metadata: { visit_id: visit.id, scheduled_at: input.scheduledAtIso, messaged },
  }).catch(() => {});

  return { ok: true, messaged };
}

/**
 * The slot does not work: offer one that does.
 *
 * The message never says no on its own. It names a specific alternative and
 * invites a counter-offer, because "that time is unavailable" leaves the
 * customer to start again and a named time lets them simply agree.
 */
export async function offerAlternativeSlot(input: {
  visitId: string;
  /** The time being offered instead. Required — there is no bare refusal. */
  proposedAtIso: string;
  actor: string;
  /** Optional, shown to the customer as the reason. Kept warm, never blaming. */
  note?: string;
}): Promise<RespondResult> {
  const visit = await loadVisit(input.visitId);
  if (!visit) return { ok: false, error: "That visit no longer exists, or the lead has no phone number.", messaged: false };

  // Still `requested`: the customer has not agreed yet, and marking it
  // scheduled would put an appointment in the diary that nobody confirmed.
  const { data: changed, error } = await db()
    .from("villa_site_visits")
    .update({ status: "requested", scheduled_at: input.proposedAtIso })
    .eq("id", input.visitId)
    .in("status", ANSWERABLE)
    .select("id");
  if (error) return { ok: false, error: "The suggestion could not be saved.", messaged: false };
  // Without the status guard this dragged a confirmed, completed or cancelled
  // visit back to `requested`, putting it in the pending list all over again.
  if (!changed || changed.length === 0) {
    return { ok: false, error: "That request has already been answered — reload to see where it stands.", messaged: false };
  }

  const slot = await humanSlot(input.proposedAtIso);
  const place = visit.project ? ` at ${visit.project}` : "";
  const reason = input.note?.trim() ? ` ${input.note.trim()}` : "";
  const body =
    `${greeting(visit.name)}, thank you for asking about a site visit${place}.` +
    `${reason} Would ${slot} suit you instead? ` +
    `If another time works better, tell us what suits and we'll arrange it around you.`;

  let messaged = true;
  try {
    await sendPlainText(visit.phone, body);
  } catch {
    messaged = false;
  }

  await logActivity({
    leadId: visit.leadId,
    type: "site_visit_alternative_offered",
    channel: "whatsapp",
    actorName: input.actor,
    description: `Suggested ${slot} instead.`,
    metadata: { visit_id: visit.id, proposed_at: input.proposedAtIso, messaged },
  }).catch(() => {});

  return { ok: true, messaged };
}

/**
 * How many requests are waiting on somebody.
 *
 * Drives the count on the bell. Returns 0 rather than throwing: a header that
 * breaks the whole page because a badge could not be counted is a bad trade.
 */
export async function pendingVisitRequests(): Promise<number> {
  try {
    const { count } = await db()
      .from("villa_site_visits")
      .select("id", { count: "exact", head: true })
      .eq("status", "requested");
    return count ?? 0;
  } catch {
    return 0;
  }
}
