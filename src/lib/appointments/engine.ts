import { mutate, read } from "../db";
import { normalisePhone } from "../ops/customers";
import { emit } from "../events/bus";
import { uid } from "../ids";
import {
  DEFAULT_AVAILABILITY,
  HOLDS_SLOT,
  type Appointment,
  type AppointmentChannel,
  type AppointmentStatus,
  type AvailabilityConfig,
  type Slot,
} from "./types";

/**
 * BOOKING ENGINE
 *
 * Two rules carry the whole thing:
 *
 *  1. A slot is offered only if it is inside opening hours, far enough ahead,
 *     not blacked out, and has capacity left.
 *  2. A booking is written only if that is still true at write time. Checking
 *     availability and then writing without re-checking is how two buyers end up
 *     on the same 4pm on a Sunday.
 */

export function availabilityFor(brandId: string): AvailabilityConfig {
  const db = read();
  const stored = db.availability?.find((a) => a.brandId === brandId);
  return stored ?? { brandId, ...DEFAULT_AVAILABILITY };
}

export function saveAvailability(next: AvailabilityConfig): AvailabilityConfig {
  mutate((d) => {
    d.availability = d.availability ?? [];
    const i = d.availability.findIndex((a) => a.brandId === next.brandId);
    if (i >= 0) d.availability[i] = next;
    else d.availability.push(next);
  });
  return next;
}

/** Minutes since midnight for "HH:MM". */
function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Live bookings currently holding a place at this exact start time. */
function held(appointments: Appointment[], startsAt: string): number {
  return appointments.filter((a) => a.startsAt === startsAt && HOLDS_SLOT.includes(a.status)).length;
}

/**
 * Every bookable slot in a window.
 *
 * `excludeAppointmentId` lets a reschedule see the slot it is currently
 * occupying as free — otherwise moving a booking by an hour and back again
 * would report its own place as taken.
 */
export function slots(
  brandId: string,
  fromISO: string,
  days = 14,
  excludeAppointmentId?: string,
): Slot[] {
  const cfg = availabilityFor(brandId);
  const db = read();
  const live = (db.appointments ?? []).filter(
    (a) => a.brandId === brandId && a.id !== excludeAppointmentId,
  );

  const now = Date.now();
  const earliest = now + cfg.minNoticeHours * 3600_000;
  const latest = now + cfg.maxAdvanceDays * 86400_000;

  const out: Slot[] = [];
  const start = new Date(fromISO);
  start.setHours(0, 0, 0, 0);

  for (let day = 0; day < days; day++) {
    const d = new Date(start);
    d.setDate(d.getDate() + day);
    if (cfg.blackoutDates.includes(isoDate(d))) continue;

    for (const window of cfg.openHours[d.getDay()] ?? []) {
      for (let m = minutes(window.start); m + cfg.slotMinutes <= minutes(window.end); m += cfg.slotMinutes) {
        const slot = new Date(d);
        slot.setHours(0, m, 0, 0);
        const t = slot.getTime();
        if (t < earliest || t > latest) continue;

        const iso = slot.toISOString();
        const remaining = cfg.concurrentCapacity - held(live, iso);
        if (remaining > 0) out.push({ startsAt: iso, remaining });
      }
    }
  }
  return out;
}

export interface BookResult {
  ok: boolean;
  appointment?: Appointment;
  error?: string;
  /** Offered when the requested time is gone, so the caller can propose one. */
  alternatives?: Slot[];
}

export interface BookInput {
  brandId: string;
  startsAt: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  leadId?: string;
  contactId?: string;
  projectId?: string;
  channel: AppointmentChannel;
  notes?: string;
  assignedTo?: string;
  createdBy: string;
}

/**
 * Phone identity is the CRM's, not a second one of our own.
 *
 * This module briefly had its own normaliser that preserved a leading "+", so
 * "+91 90000 55555" and "919000055555" — the same buyer, typed two ways —
 * compared as different people. The duplicate-submit guard therefore missed,
 * and one person quietly consumed two places in a capacity-2 slot. Customer
 * identity already has exactly one canonical form in src/lib/ops/customers.ts,
 * and appointments must resolve a person the same way the customer record does
 * or the two will disagree about who booked.
 */
export { normalisePhone } from "../ops/customers";

export function book(input: BookInput): BookResult {
  const phone = normalisePhone(input.customerPhone);
  if (!phone || phone.replace(/\D/g, "").length < 7) {
    return { ok: false, error: "A reachable phone number is required — the confirmation goes there." };
  }
  if (!input.customerName.trim()) return { ok: false, error: "A name is required." };

  const when = new Date(input.startsAt);
  if (Number.isNaN(when.getTime())) return { ok: false, error: "That is not a valid date and time." };

  const cfg = availabilityFor(input.brandId);
  const iso = when.toISOString();

  // Re-derive availability at write time. The caller's list may be minutes old.
  const open = slots(input.brandId, iso, 1).some((s) => s.startsAt === iso);
  if (!open) {
    return {
      ok: false,
      error: "That time is no longer available.",
      alternatives: slots(input.brandId, new Date().toISOString(), 7).slice(0, 6),
    };
  }

  // One live booking per person per slot. A double submit is not two visits.
  const db = read();
  const dupe = (db.appointments ?? []).find(
    (a) =>
      a.brandId === input.brandId &&
      a.startsAt === iso &&
      normalisePhone(a.customerPhone) === phone &&
      HOLDS_SLOT.includes(a.status),
  );
  if (dupe) return { ok: true, appointment: dupe };

  const now = new Date().toISOString();
  const appointment: Appointment = {
    id: uid("apt"),
    brandId: input.brandId,
    projectId: input.projectId,
    leadId: input.leadId,
    contactId: input.contactId,
    customerName: input.customerName.trim().slice(0, 120),
    customerPhone: phone,
    customerEmail: input.customerEmail?.trim().slice(0, 200),
    startsAt: iso,
    durationMinutes: cfg.slotMinutes,
    status: "confirmed",
    channel: input.channel,
    assignedTo: input.assignedTo,
    notes: input.notes?.slice(0, 1000),
    history: [{ at: now, by: input.createdBy, from: "created", to: "confirmed" }],
    createdAt: now,
    createdBy: input.createdBy,
    updatedAt: now,
  };

  mutate((d) => {
    d.appointments = d.appointments ?? [];
    d.appointments.push(appointment);

    // Keep the lead's own view of the visit in step, so the pipeline stage and
    // the appointment cannot disagree about when the buyer is coming.
    if (input.leadId) {
      const lead = d.leads.find((l) => l.id === input.leadId);
      if (lead) {
        lead.siteVisitAt = iso;
        if (lead.status === "new" || lead.status === "contacted") lead.status = "site_visit_scheduled";
      }
    }
  });

  // Fire-and-forget: the visit is already written and the customer already has
  // their slot. emit() returns void precisely so this line cannot be awaited
  // into the booking path — a dead n8n must not cost anybody a site visit.
  emit("appointment.booked", eventPayload(appointment));

  return { ok: true, appointment };
}

/**
 * What a subscriber is told about an appointment.
 *
 * Built explicitly rather than spreading the record, so adding an internal
 * field later does not silently start posting it to third-party endpoints.
 */
function eventPayload(a: Appointment): Record<string, unknown> {
  return {
    appointmentId: a.id,
    brandId: a.brandId,
    projectId: a.projectId,
    leadId: a.leadId,
    startsAt: a.startsAt,
    durationMinutes: a.durationMinutes,
    status: a.status,
    channel: a.channel,
    assignedTo: a.assignedTo,
    customerName: a.customerName,
    customerPhone: a.customerPhone,
    customerEmail: a.customerEmail,
  };
}

export interface TransitionInput {
  id: string;
  to: AppointmentStatus;
  by: string;
  reason?: string;
  /** Only for a reschedule. */
  newStartsAt?: string;
}

/** Which moves are legal. A completed visit does not become "requested" again. */
const ALLOWED: Record<AppointmentStatus, AppointmentStatus[]> = {
  requested: ["confirmed", "rescheduled", "cancelled"],
  confirmed: ["rescheduled", "completed", "no_show", "cancelled"],
  rescheduled: ["confirmed", "rescheduled", "completed", "no_show", "cancelled"],
  completed: [],
  no_show: ["rescheduled"],
  cancelled: [],
};

export function transition(input: TransitionInput): BookResult {
  const db = read();
  const current = (db.appointments ?? []).find((a) => a.id === input.id);
  if (!current) return { ok: false, error: "That appointment does not exist." };

  if (!ALLOWED[current.status].includes(input.to)) {
    return { ok: false, error: `A ${current.status} appointment cannot become ${input.to}.` };
  }
  if ((input.to === "cancelled" || input.to === "no_show") && !input.reason?.trim()) {
    return { ok: false, error: `A reason is required to mark this ${input.to.replace("_", " ")}.` };
  }

  let target = current.startsAt;
  if (input.to === "rescheduled") {
    if (!input.newStartsAt) return { ok: false, error: "A new time is required to reschedule." };
    const when = new Date(input.newStartsAt);
    if (Number.isNaN(when.getTime())) return { ok: false, error: "That is not a valid date and time." };
    target = when.toISOString();
    // The appointment's own slot does not count against it.
    const free = slots(current.brandId, target, 1, current.id).some((s) => s.startsAt === target);
    if (!free) {
      return {
        ok: false,
        error: "That time is not available.",
        alternatives: slots(current.brandId, new Date().toISOString(), 7, current.id).slice(0, 6),
      };
    }
  }

  const now = new Date().toISOString();
  let updated: Appointment | undefined;
  mutate((d) => {
    const a = (d.appointments ?? []).find((x) => x.id === input.id);
    if (!a) return;
    a.history.push({ at: now, by: input.by, from: a.status, to: input.to, reason: input.reason });
    a.status = input.to;
    a.startsAt = target;
    a.updatedAt = now;
    if (input.to === "cancelled") a.cancelledReason = input.reason;
    if (a.leadId) {
      const lead = d.leads.find((l) => l.id === a.leadId);
      if (lead) lead.siteVisitAt = HOLDS_SLOT.includes(input.to) ? target : undefined;
    }
    updated = a;
  });

  // Only the moves an automation can act on. A "completed" or "no_show" has no
  // event in the contract, and inventing one here would mean n8n workflows
  // keying on a name this codebase never promised to keep.
  if (updated) {
    if (input.to === "rescheduled") {
      emit("appointment.rescheduled", { ...eventPayload(updated), previousStartsAt: current.startsAt });
    } else if (input.to === "cancelled") {
      emit("appointment.cancelled", { ...eventPayload(updated), reason: input.reason });
    }
  }

  return { ok: true, appointment: updated };
}

export function listAppointments(
  brandId: string,
  opts: { from?: string; to?: string; status?: AppointmentStatus[] } = {},
): Appointment[] {
  const db = read();
  return (db.appointments ?? [])
    .filter((a) => a.brandId === brandId)
    .filter((a) => (opts.from ? a.startsAt >= opts.from : true))
    .filter((a) => (opts.to ? a.startsAt <= opts.to : true))
    .filter((a) => (opts.status?.length ? opts.status.includes(a.status) : true))
    .sort((x, y) => x.startsAt.localeCompare(y.startsAt));
}

/**
 * Visits needing a reminder: confirmed, starting inside the window, not yet
 * reminded. Called by the worker tick rather than on a page load, so it fires
 * whether or not anyone is looking at the screen.
 */
export function dueReminders(brandId: string, withinHours = 24): Appointment[] {
  const now = Date.now();
  const until = now + withinHours * 3600_000;
  return listAppointments(brandId, { status: ["confirmed", "rescheduled"] }).filter((a) => {
    const t = new Date(a.startsAt).getTime();
    return !a.reminderSentAt && t > now && t <= until;
  });
}

export function markReminded(id: string): void {
  mutate((d) => {
    const a = (d.appointments ?? []).find((x) => x.id === id);
    if (a) a.reminderSentAt = new Date().toISOString();
  });
}

export function markConfirmationSent(id: string): void {
  mutate((d) => {
    const a = (d.appointments ?? []).find((x) => x.id === id);
    if (a) a.confirmationSentAt = new Date().toISOString();
  });
}
