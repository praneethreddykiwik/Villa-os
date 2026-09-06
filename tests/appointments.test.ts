import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { cleanup, isolate } from "./helpers";

const dir = isolate("appointments");
after(() => cleanup(dir));

/* Imports must follow isolate() so the store points at the temp directory. */
const { read, mutate, resetToBootstrap } = require("../src/lib/db") as typeof import("../src/lib/db");
const { uid } = require("../src/lib/ids") as typeof import("../src/lib/ids");
const { availabilityFor, saveAvailability, slots, book, transition, listAppointments, zonedDate, zonedInstant } =
  require("../src/lib/appointments/engine") as typeof import("../src/lib/appointments/engine");
const { DEFAULT_AVAILABILITY, HOLDS_SLOT } = require("../src/lib/appointments/types") as typeof import("../src/lib/appointments/types");
const { sendDueReminders } = require("../src/lib/notify/reminders") as typeof import("../src/lib/notify/reminders");
import type { AppointmentStatus, AvailabilityConfig } from "../src/lib/appointments/types";
import type { BookResult } from "../src/lib/appointments/engine";

let BRAND = "";
before(() => {
  resetToBootstrap();
  BRAND = read().brands[0].id;
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/*                                                                             */
/* Availability is written whole rather than merged, so no test inherits a      */
/* narrowed window or a leftover blackout from the one above it. Slot maths is  */
/* wall-clock in the brand timezone (not the host's), so every expected time    */
/* is built through the same zone helpers instead of setHours() or a UTC        */
/* instant that would only be right on one host.                               */
/* -------------------------------------------------------------------------- */

const BUSINESS_HOURS = [{ start: "10:00", end: "18:00" }];

function everyDay(windows: Array<{ start: string; end: string }>): Record<number, Array<{ start: string; end: string }>> {
  return { 0: windows, 1: windows, 2: windows, 3: windows, 4: windows, 5: windows, 6: windows };
}

function configure(patch: Partial<AvailabilityConfig> = {}): AvailabilityConfig {
  return saveAvailability({
    ...DEFAULT_AVAILABILITY,
    brandId: BRAND,
    openHours: everyDay(BUSINESS_HOURS),
    slotMinutes: 60,
    concurrentCapacity: 2,
    minNoticeHours: 0,
    maxAdvanceDays: 365,
    blackoutDates: [],
    ...patch,
  });
}

function clearAppointments(): void {
  mutate((d) => {
    d.appointments = [];
  });
}

const TZ = DEFAULT_AVAILABILITY.timezone;

/** Brand-zone midnight, n days from today — the same anchor `slots()` starts from. */
function dayAhead(n: number): Date {
  return zonedInstant(zonedDate(new Date(Date.now() + n * 86400_000), TZ), 0, TZ);
}

/** The ISO instant of a whole hour on that day, as the engine would emit it. */
function at(day: Date, hour: number): string {
  return zonedInstant(zonedDate(day, TZ), hour * 60, TZ).toISOString();
}

function bookAt(startsAt: string, phone: string, extra: Partial<Parameters<typeof book>[0]> = {}): BookResult {
  return book({
    brandId: BRAND,
    startsAt,
    customerName: "Test Buyer",
    customerPhone: phone,
    channel: "phone",
    createdBy: "tester@test.invalid",
    ...extra,
  });
}

function remainingAt(day: Date, startsAt: string): number | undefined {
  return slots(BRAND, day.toISOString(), 1).find((s) => s.startsAt === startsAt)?.remaining;
}

/** A lead to hang a visit off, with the fields the CRM type requires. */
function seedLead(): string {
  const id = uid("lead");
  const now = new Date().toISOString();
  mutate((d) => {
    d.leads.push({
      id,
      brandId: BRAND,
      name: "Site Visit Lead",
      phone: "+919000012345",
      city: "Bengaluru",
      status: "contacted",
      budgetMin: 30_000_000,
      budgetMax: 50_000_000,
      source: "website",
      projectInterest: "Glentree Villas",
      unitType: "4BHK",
      assignedTo: "tester@test.invalid",
      score: 40,
      isHNWI: false,
      kycStatus: "not_started",
      createdAt: now,
      updatedAt: now,
      tags: [],
    });
  });
  return id;
}

/* ========================================================================== */
describe("slot generation", () => {
  test("offers times inside opening hours and nothing outside them", () => {
    configure({ openHours: everyDay([{ start: "10:00", end: "13:00" }]) });
    const day = dayAhead(2);
    const offered = slots(BRAND, day.toISOString(), 1).map((s) => s.startsAt);

    assert.ok(offered.includes(at(day, 10)), "the first slot of the window must be offered");
    assert.ok(offered.includes(at(day, 12)), "a slot that ends exactly at closing time is still a slot");
    assert.ok(!offered.includes(at(day, 9)), "an hour before opening must not be offered");
    assert.ok(!offered.includes(at(day, 13)), "a slot that would run past closing must not be offered");
  });

  test("minNoticeHours hides imminent times and maxAdvanceDays hides distant ones", () => {
    configure();
    const wide = slots(BRAND, new Date().toISOString(), 20);

    const notice = 48;
    const cutoff = Date.now() + notice * 3600_000;
    assert.ok(wide.some((s) => new Date(s.startsAt).getTime() < cutoff), "fixture must contain an imminent slot");

    configure({ minNoticeHours: notice });
    const guarded = slots(BRAND, new Date().toISOString(), 20);
    assert.ok(guarded.length > 0, "notice must narrow the list, not empty it");
    assert.ok(
      guarded.every((s) => new Date(s.startsAt).getTime() >= cutoff),
      "no slot inside the notice period may survive",
    );

    const horizon = Date.now() + 3 * 86400_000;
    assert.ok(wide.some((s) => new Date(s.startsAt).getTime() > horizon), "fixture must contain a distant slot");

    configure({ maxAdvanceDays: 3 });
    const near = slots(BRAND, new Date().toISOString(), 20);
    assert.ok(near.length > 0);
    assert.ok(
      near.every((s) => new Date(s.startsAt).getTime() <= horizon),
      "nothing beyond the booking horizon may be offered",
    );
  });

  test("a blackout date offers nothing at all", () => {
    const day = dayAhead(5);
    configure();
    assert.ok(slots(BRAND, day.toISOString(), 1).length > 0, "the day must be open before it is closed");

    // Keyed exactly as the engine keys it (brand-zone calendar date), so the
    // assertion is about the blackout rule rather than the host's clock.
    configure({ blackoutDates: [zonedDate(day, TZ)] });
    assert.equal(slots(BRAND, day.toISOString(), 1).length, 0);
  });
});

/* ========================================================================== */
describe("booking and capacity", () => {
  test("each booking consumes a place and the slot closes when they run out", () => {
    configure({ concurrentCapacity: 2 });
    clearAppointments();
    const day = dayAhead(3);
    const when = at(day, 11);

    assert.equal(remainingAt(day, when), 2);

    const first = bookAt(when, "+91 90000 00001");
    assert.equal(first.ok, true, first.error);
    assert.equal(remainingAt(day, when), 1, "one booking must consume exactly one place");

    const second = bookAt(when, "+91 90000 00002", { customerName: "Second Buyer" });
    assert.equal(second.ok, true, second.error);
    assert.equal(remainingAt(day, when), undefined, "a full slot is no longer offered");

    const third = bookAt(when, "+91 90000 00003", { customerName: "Third Buyer" });
    assert.equal(third.ok, false, "the third party must not be sold a slot for two");
    assert.ok(third.alternatives && third.alternatives.length > 0, "a refusal must offer another time");
    assert.ok(
      third.alternatives!.every((s) => s.startsAt !== when),
      "the time that was just refused must not come back as an alternative",
    );
    assert.equal(listAppointments(BRAND, { from: when, to: when }).length, 2);
  });

  test("the same person submitting twice gets one appointment, not two", () => {
    configure({ concurrentCapacity: 2 });
    clearAppointments();
    const day = dayAhead(4);
    const when = at(day, 12);

    const first = bookAt(when, "+91 90000 55555");
    const again = bookAt(when, "+91 (90000) 55555");

    assert.equal(first.ok, true, first.error);
    assert.equal(again.ok, true, again.error);
    assert.equal(again.appointment!.id, first.appointment!.id, "a double submit is one visit");
    assert.equal(listAppointments(BRAND, { from: when, to: when }).length, 1);
    assert.equal(remainingAt(day, when), 1, "the retry must not have eaten the second place");
  });

  test("refuses a phone number nobody could be reached on", () => {
    configure();
    clearAppointments();
    const result = bookAt(at(dayAhead(3), 10), "12345");
    assert.equal(result.ok, false);
    assert.match(result.error!, /phone/i);
  });
});

/* ========================================================================== */
describe("transitions", () => {
  test("reschedules into a free slot, refuses a full one, and does not block itself", () => {
    // Capacity of one makes "the slot is taken" unambiguous: any other live
    // booking at that time is the whole of the contention.
    configure({ concurrentCapacity: 1 });
    clearAppointments();
    const day = dayAhead(6);
    const origin = at(day, 10);
    const free = at(day, 11);
    const taken = at(day, 12);

    const mine = bookAt(origin, "+91 90000 77771").appointment!;
    bookAt(taken, "+91 90000 77772", { customerName: "Occupier" });

    const moved = transition({ id: mine.id, to: "rescheduled", by: "tester", newStartsAt: free });
    assert.equal(moved.ok, true, moved.error);
    assert.equal(moved.appointment!.startsAt, free);
    assert.equal(moved.appointment!.status, "rescheduled");

    const inPlace = transition({ id: mine.id, to: "rescheduled", by: "tester", newStartsAt: free });
    assert.equal(inPlace.ok, true, "an appointment must not count as competition for its own slot");

    const clash = transition({ id: mine.id, to: "rescheduled", by: "tester", newStartsAt: taken });
    assert.equal(clash.ok, false, "a full slot must refuse an incoming reschedule");
    assert.ok(clash.alternatives && clash.alternatives.length > 0);
    assert.equal(read().appointments!.find((a) => a.id === mine.id)!.startsAt, free, "a refused move changes nothing");

    const noTime = transition({ id: mine.id, to: "rescheduled", by: "tester" });
    assert.equal(noTime.ok, false);
    assert.match(noTime.error!, /new time/i);
  });

  test("cancelling and marking a no-show both require a reason", () => {
    configure();
    clearAppointments();
    const apt = bookAt(at(dayAhead(7), 10), "+91 90000 88881").appointment!;

    const unexplained = transition({ id: apt.id, to: "cancelled", by: "tester" });
    assert.equal(unexplained.ok, false);
    assert.match(unexplained.error!, /reason/i);

    const blank = transition({ id: apt.id, to: "no_show", by: "tester", reason: "   " });
    assert.equal(blank.ok, false, "whitespace is not a reason");

    const cancelled = transition({ id: apt.id, to: "cancelled", by: "tester", reason: "Buyer postponed the trip" });
    assert.equal(cancelled.ok, true, cancelled.error);
    assert.equal(cancelled.appointment!.cancelledReason, "Buyer postponed the trip");
    assert.equal(cancelled.appointment!.history.at(-1)!.reason, "Buyer postponed the trip");
  });

  test("a completed visit is terminal", () => {
    configure();
    clearAppointments();
    const day = dayAhead(8);
    const apt = bookAt(at(day, 10), "+91 90000 99991").appointment!;

    const done = transition({ id: apt.id, to: "completed", by: "tester" });
    assert.equal(done.ok, true, done.error);

    const targets: AppointmentStatus[] = ["confirmed", "rescheduled", "completed", "no_show", "cancelled"];
    for (const to of targets) {
      const attempt = transition({
        id: apt.id,
        to,
        by: "tester",
        reason: "second thoughts",
        newStartsAt: at(day, 15),
      });
      assert.equal(attempt.ok, false, `a completed visit must not become ${to}`);
      assert.equal(read().appointments!.find((a) => a.id === apt.id)!.status, "completed");
    }
  });

  test("refuses to move an appointment that does not exist", () => {
    const missing = transition({ id: "apt_nope", to: "confirmed", by: "tester" });
    assert.equal(missing.ok, false);
    assert.match(missing.error!, /does not exist/i);
  });
});

/* ========================================================================== */
describe("lead linkage", () => {
  test("the lead's site visit follows the booking and is cleared on cancel", () => {
    configure();
    clearAppointments();
    const leadId = seedLead();
    const day = dayAhead(9);
    const when = at(day, 10);

    const booked = bookAt(when, "+91 90000 12345", { leadId });
    assert.equal(booked.ok, true, booked.error);

    const afterBooking = read().leads.find((l) => l.id === leadId)!;
    assert.equal(afterBooking.siteVisitAt, when, "the lead must carry the time that was actually booked");
    assert.equal(afterBooking.status, "site_visit_scheduled");

    const moved = transition({
      id: booked.appointment!.id,
      to: "rescheduled",
      by: "tester",
      newStartsAt: at(day, 14),
    });
    assert.equal(moved.ok, true, moved.error);
    assert.equal(
      read().leads.find((l) => l.id === leadId)!.siteVisitAt,
      at(day, 14),
      "the lead must not keep pointing at a time the visit has moved off",
    );

    const cancelled = transition({
      id: booked.appointment!.id,
      to: "cancelled",
      by: "tester",
      reason: "Buyer bought elsewhere",
    });
    assert.equal(cancelled.ok, true, cancelled.error);
    assert.equal(
      read().leads.find((l) => l.id === leadId)!.siteVisitAt,
      undefined,
      "a cancelled visit must not leave a date on the lead",
    );
  });
});

/* ========================================================================== */
describe("availability configuration", () => {
  test("falls back to the defaults until something is saved, then persists", () => {
    const brandId = "brd_never_configured";
    assert.equal(availabilityFor(brandId).slotMinutes, DEFAULT_AVAILABILITY.slotMinutes);

    saveAvailability({ ...DEFAULT_AVAILABILITY, brandId, slotMinutes: 90 });
    assert.equal(availabilityFor(brandId).slotMinutes, 90);
    assert.equal(availabilityFor(BRAND).slotMinutes, 60, "one brand's hours must not leak into another's");
  });
});

describe("one buyer is one buyer, however the number is typed", () => {
  test("a leading + does not fork the person and eat a second place", () => {
    // Regression: appointments carried their own normaliser that kept the "+",
    // so "+91 90000 55555" and "919000055555" compared as two people. The
    // duplicate-submit guard missed and one buyer consumed both places in a
    // capacity-2 slot, locking out a real second party.
    const brandId = read().brands[0].id;
    saveAvailability({ ...availabilityFor(brandId), concurrentCapacity: 2 });
    const slot = slots(brandId, new Date().toISOString(), 14)[0];
    assert.ok(slot, "expected a bookable slot");

    const base = {
      brandId, startsAt: slot.startsAt, customerName: "Same Buyer",
      channel: "whatsapp" as const, createdBy: "test",
    };
    const a = book({ ...base, customerPhone: "+91 90000 55555" });
    const b = book({ ...base, customerPhone: "919000055555" });

    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(b.appointment!.id, a.appointment!.id, "the same number in two formats is one booking");

    const held = read().appointments.filter(
      (x) => x.startsAt === slot.startsAt && HOLDS_SLOT.includes(x.status),
    );
    assert.equal(held.length, 1, "one person must not consume two places");

    // The second place is still there for somebody else.
    const other = book({ ...base, customerName: "Other Buyer", customerPhone: "+91 90000 66666" });
    assert.equal(other.ok, true, "a genuinely different buyer must still fit");
  });
});

/* ========================================================================== */
describe("notifications", () => {
  /** The engine notifies fire-and-forget; wait for the log to catch up. */
  async function logged(id: string, event: string, tries = 50): Promise<number> {
    for (let i = 0; i < tries; i++) {
      const n = read().notificationLog.filter((x) => x.entityId === id && x.event === event).length;
      if (n) return n;
      await new Promise((r) => setTimeout(r, 10));
    }
    return 0;
  }

  test("every booking and status move writes delivery outcomes", async () => {
    configure();
    clearAppointments();
    mutate((d) => { d.notificationLog = []; });
    const day = dayAhead(10);
    const apt = bookAt(at(day, 10), "+91 90000 31313", { assignedTo: "Nobody Known" }).appointment!;

    assert.ok(await logged(apt.id, "appointment.booked"), "booking must notify");
    // In-app is always on; email is unconfigured in tests and says so.
    const rows = read().notificationLog.filter((n) => n.entityId === apt.id);
    assert.ok(rows.some((n) => n.channel === "in_app" && n.ok));
    assert.ok(rows.some((n) => n.channel === "email" && !n.ok && /not configured/.test(n.detail)));
    assert.ok(read().opsNotifications.some((n) => n.event === "appointment.booked" && n.recipientRole === "SALES_MANAGER"));

    transition({ id: apt.id, to: "rescheduled", by: "tester", newStartsAt: at(day, 12) });
    assert.ok(await logged(apt.id, "appointment.rescheduled"));
    transition({ id: apt.id, to: "cancelled", by: "tester", reason: "Changed plans" });
    assert.ok(await logged(apt.id, "appointment.cancelled"));

    const done = bookAt(at(day, 14), "+91 90000 31314").appointment!;
    transition({ id: done.id, to: "completed", by: "tester" });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await logged(done.id, "appointment.completed", 1), 0, "completing is a record, not news");
  });

  test("reminders go once, and never to a cancelled visit", async () => {
    configure();
    clearAppointments();
    mutate((d) => { d.notificationLog = []; });
    const day = dayAhead(10);
    const soon = bookAt(at(day, 10), "+91 90000 41414").appointment!;
    const gone = bookAt(at(day, 11), "+91 90000 41415").appointment!;
    const far = bookAt(at(day, 12), "+91 90000 41416").appointment!;
    transition({ id: gone.id, to: "cancelled", by: "tester", reason: "Not coming" });

    // Pull two of them inside the window without going through the slot rules.
    const inTwoHours = new Date(Date.now() + 2 * 3600_000).toISOString();
    mutate((d) => {
      for (const a of d.appointments) {
        if (a.id === soon.id || a.id === gone.id) a.startsAt = inTwoHours;
      }
    });

    const first = await sendDueReminders();
    assert.equal(first.considered, 1, "only the live visit inside 24h is due");
    assert.equal(read().appointments.find((a) => a.id === soon.id)!.reminderSentAt !== undefined, true);
    assert.equal(read().appointments.find((a) => a.id === gone.id)!.reminderSentAt, undefined, "cancelled is never reminded");
    assert.equal(read().appointments.find((a) => a.id === far.id)!.reminderSentAt, undefined, "outside the window is not due");
    assert.equal(read().notificationLog.filter((n) => n.entityId === soon.id && n.event === "appointment.reminder").length > 0, true);
    assert.equal(read().notificationLog.some((n) => n.entityId === gone.id && n.event === "appointment.reminder"), false);

    const second = await sendDueReminders();
    assert.equal(second.considered, 0, "a second tick must not remind again");
    assert.equal(
      read().notificationLog.filter((n) => n.entityId === soon.id && n.event === "appointment.reminder" && n.channel === "in_app").length,
      1,
    );
  });

  test("a rescheduled visit is reminded again for its new time", async () => {
    configure();
    clearAppointments();
    mutate((d) => { d.notificationLog = []; });
    const day = dayAhead(10);
    const apt = bookAt(at(day, 10), "+91 90000 51515").appointment!;
    const inTwoHours = new Date(Date.now() + 2 * 3600_000).toISOString();
    mutate((d) => { d.appointments.find((a) => a.id === apt.id)!.startsAt = inTwoHours; });

    const first = await sendDueReminders();
    assert.equal(first.considered, 1);
    assert.ok(read().appointments.find((a) => a.id === apt.id)!.reminderSentAt);

    // Moving the visit clears the stamp so the new time gets its own reminder.
    const moved = transition({ id: apt.id, to: "rescheduled", by: "tester", newStartsAt: at(day, 12) });
    assert.equal(moved.ok, true);
    assert.equal(read().appointments.find((a) => a.id === apt.id)!.reminderSentAt, undefined);
    mutate((d) => { d.appointments.find((a) => a.id === apt.id)!.startsAt = inTwoHours; });

    const again = await sendDueReminders();
    assert.equal(again.considered, 1, "the moved visit is due once more");
    assert.equal(
      read().notificationLog.filter((n) => n.entityId === apt.id && n.event === "appointment.reminder" && n.channel === "in_app").length,
      2,
    );
  });
});
