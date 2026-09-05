/**
 * SITE VISIT APPOINTMENTS
 *
 * A villa sale turns on getting the buyer onto the plot. Until now the CRM only
 * carried a `siteVisitAt` timestamp on the lead, auto-filled to "three days from
 * now" when someone moved the lead to `site_visit_scheduled` — a date nobody
 * chose, that nobody was told, and that nothing could double-book against.
 *
 * This models the real thing: bookable slots derived from configured opening
 * hours, a booking that holds one slot against one lead, and the state a visit
 * actually moves through.
 */

export type AppointmentStatus =
  | "requested"   // customer asked; nobody has confirmed a time yet
  | "confirmed"   // slot held, both sides told
  | "rescheduled" // moved at least once; still live
  | "completed"   // the visit happened
  | "no_show"     // the time passed and nobody came
  | "cancelled";

/** Live statuses hold a slot; terminal ones release it. */
export const HOLDS_SLOT: AppointmentStatus[] = ["requested", "confirmed", "rescheduled"];

export type AppointmentChannel = "whatsapp" | "phone" | "walk_in" | "website" | "instagram" | "staff";

export interface Appointment {
  id: string;
  brandId: string;
  /** The project the buyer is coming to see. */
  projectId?: string;
  leadId?: string;
  contactId?: string;

  customerName: string;
  /** E.164-ish. The reminder and the confirmation both go here. */
  customerPhone: string;
  customerEmail?: string;

  /** Slot start, ISO 8601 with offset. Duration comes from the config. */
  startsAt: string;
  durationMinutes: number;

  status: AppointmentStatus;
  channel: AppointmentChannel;

  /** Staff member who will host. Unassigned is allowed — the desk fills it in. */
  assignedTo?: string;
  notes?: string;

  /** Every move is kept, so "why is this on Thursday now" has an answer. */
  history: Array<{
    at: string;
    by: string;
    from: AppointmentStatus | "created";
    to: AppointmentStatus;
    reason?: string;
  }>;

  createdAt: string;
  createdBy: string;
  updatedAt: string;
  /** Set when the confirmation actually went out, not when it was queued. */
  confirmationSentAt?: string;
  reminderSentAt?: string;
  cancelledReason?: string;
}

/**
 * Opening hours and capacity.
 *
 * Deliberately per-brand rather than global: a second project in another city
 * keeps its own hours without a code change.
 */
export interface AvailabilityConfig {
  brandId: string;
  timezone: string;
  /** 0 = Sunday … 6 = Saturday. Days absent from this map are closed. */
  openHours: Record<number, Array<{ start: string; end: string }>>;
  slotMinutes: number;
  /** How many parties can be shown around at the same time. */
  concurrentCapacity: number;
  /** Refuse bookings sooner than this — the team needs warning. */
  minNoticeHours: number;
  /** Refuse bookings further out than this. */
  maxAdvanceDays: number;
  /** ISO dates (YYYY-MM-DD) that are closed regardless of openHours. */
  blackoutDates: string[];
}

export const DEFAULT_AVAILABILITY: Omit<AvailabilityConfig, "brandId"> = {
  timezone: "Asia/Kolkata",
  openHours: {
    1: [{ start: "10:00", end: "18:00" }],
    2: [{ start: "10:00", end: "18:00" }],
    3: [{ start: "10:00", end: "18:00" }],
    4: [{ start: "10:00", end: "18:00" }],
    5: [{ start: "10:00", end: "18:00" }],
    6: [{ start: "10:00", end: "18:00" }],
    // Sunday is the day site visits actually happen for working buyers.
    0: [{ start: "11:00", end: "17:00" }],
  },
  slotMinutes: 60,
  concurrentCapacity: 2,
  minNoticeHours: 2,
  maxAdvanceDays: 45,
  blackoutDates: [],
};

export interface Slot {
  /** ISO start of the slot. */
  startsAt: string;
  /** Remaining places at this time. */
  remaining: number;
}
