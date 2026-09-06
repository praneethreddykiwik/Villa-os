import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, afterEach, before, describe } from "node:test";
import { cleanup, isolate, seedTeam } from "./helpers";

const dir = isolate("notify");
after(() => cleanup(dir));

const { read, mutate, resetToBootstrap } = require("../src/lib/db") as typeof import("../src/lib/db");
const { notify, notifyAppointment, sendEmail, emailConfigured, configuredRecipients } =
  require("../src/lib/notify") as typeof import("../src/lib/notify");
const { icsFor, icsLocal } = require("../src/lib/notify/ics") as typeof import("../src/lib/notify/ics");
const { defaultOrgId } = require("../src/lib/ops/seed") as typeof import("../src/lib/ops/seed");
import type { Appointment } from "../src/lib/appointments/types";

const ROOT = process.cwd();

let BRAND = "";
before(() => {
  resetToBootstrap();
  BRAND = read().brands[0].id;
  seedTeam(defaultOrgId());
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.RESEND_API_KEY;
  delete process.env.NOTIFY_FROM_EMAIL;
  delete process.env.NOTIFY_EMAILS;
});

/** Captures the Resend request instead of sending it. */
function stubResend(status = 200, body: unknown = { id: "email_123" }) {
  const calls: Array<{ url: string; init: RequestInit; json: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).startsWith("https://api.resend.com/")) return realFetch(url, init);
    const json = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(url), init: init ?? {}, json });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

function configure() {
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.NOTIFY_FROM_EMAIL = "Villa OS <visits@test.invalid>";
  process.env.NOTIFY_EMAILS = "sales@test.invalid, ops@test.invalid,,";
}

function sample(patch: Partial<Appointment> = {}): Appointment {
  // 2026-09-06T04:30:00Z is 10:00 IST on a Sunday.
  const now = "2026-09-01T10:00:00.000Z";
  return {
    id: "apt_test1",
    brandId: BRAND,
    customerName: "Asha Rao",
    customerPhone: "919000011111",
    startsAt: "2026-09-06T04:30:00.000Z",
    durationMinutes: 60,
    status: "confirmed",
    channel: "website",
    assignedTo: "Sales Manager 1",
    notes: "Wants the corner plot; semicolons, commas, and\nnewlines in here",
    history: [{ at: now, by: "desk", from: "created", to: "confirmed" }],
    createdAt: now,
    createdBy: "desk",
    updatedAt: now,
    ...patch,
  };
}

describe("email via Resend", () => {
  test("not configured is an outcome, not an exception", async () => {
    assert.equal(emailConfigured(), false);
    const out = await sendEmail({ to: ["x@test.invalid"], subject: "s", text: "t" });
    assert.equal(out.ok, false);
    assert.match(out.detail, /not configured/);
    assert.match(out.detail, /RESEND_API_KEY/);
  });

  test("half-configured still counts as not configured", async () => {
    process.env.RESEND_API_KEY = "re_only";
    assert.equal(emailConfigured(), false);
    const calls = stubResend();
    const out = await sendEmail({ to: ["x@test.invalid"], subject: "s", text: "t" });
    assert.equal(out.ok, false);
    assert.equal(calls.length, 0, "nothing may leave without a from address");
  });

  test("posts to Resend with from, recipients, subject and base64 attachment", async () => {
    configure();
    const calls = stubResend();
    assert.deepEqual(configuredRecipients(), ["sales@test.invalid", "ops@test.invalid"]);

    const out = await sendEmail({
      to: ["a@test.invalid", "a@test.invalid", "b@test.invalid"],
      subject: "Site visit",
      text: "body",
      attachments: [{ filename: "visit.ics", content: Buffer.from("BEGIN:VCALENDAR").toString("base64"), contentType: "text/calendar" }],
    });
    assert.equal(out.ok, true, out.detail);
    assert.match(out.detail, /email_123/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.resend.com/emails");
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer re_test_key");
    assert.equal(calls[0].json.from, "Villa OS <visits@test.invalid>");
    assert.deepEqual(calls[0].json.to, ["a@test.invalid", "b@test.invalid"], "duplicates collapse");
    assert.equal(calls[0].json.subject, "Site visit");
    const att = (calls[0].json.attachments as Array<Record<string, string>>)[0];
    assert.equal(att.filename, "visit.ics");
    assert.equal(Buffer.from(att.content, "base64").toString(), "BEGIN:VCALENDAR");
  });

  test("a rejected send and a thrown fetch both come back as failed outcomes", async () => {
    configure();
    stubResend(422, { message: "domain not verified" });
    const bad = await sendEmail({ to: ["a@test.invalid"], subject: "s", text: "t" });
    assert.equal(bad.ok, false);
    assert.match(bad.detail, /422/);
    assert.match(bad.detail, /domain not verified/);

    globalThis.fetch = (async () => { throw new Error("ECONNRESET"); }) as typeof fetch;
    const down = await sendEmail({ to: ["a@test.invalid"], subject: "s", text: "t" });
    assert.equal(down.ok, false);
    assert.match(down.detail, /ECONNRESET/);
  });
});

describe("ICS", () => {
  test("renders Asia/Kolkata wall-clock times with a timezone block", () => {
    assert.equal(icsLocal("2026-09-06T04:30:00.000Z"), "20260906T100000");
    const ics = icsFor(sample(), { brandName: "Glentree" });
    assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
    assert.ok(ics.includes("TZID:Asia/Kolkata"));
    assert.ok(ics.includes("TZOFFSETTO:+0530"));
    assert.ok(ics.includes("DTSTART;TZID=Asia/Kolkata:20260906T100000"));
    assert.ok(ics.includes("DTEND;TZID=Asia/Kolkata:20260906T110000"));
    assert.ok(ics.includes("UID:apt_test1@villa-os"));
    assert.ok(ics.includes("SEQUENCE:1"));
    assert.ok(ics.includes("STATUS:CONFIRMED"));
    assert.ok(ics.includes("METHOD:REQUEST"));
    assert.ok(ics.includes("LOCATION:Glentree"));
    assert.ok(/SUMMARY:Site visit — Asha Rao \(Glentree\)/.test(ics));
    // Special characters are escaped and the newline survives as a literal \n.
    assert.ok(ics.replace(/\r\n /g, "").includes("semicolons\\, commas\\, and\\nnewlines"), "text is escaped");
    assert.ok(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 76), "lines are folded to 75 octets");
  });

  test("a cancelled visit is a CANCEL", () => {
    const ics = icsFor(sample({ status: "cancelled" }));
    assert.ok(ics.includes("METHOD:CANCEL"));
    assert.ok(ics.includes("STATUS:CANCELLED"));
  });

  test("the ICS route is gated on sales.read", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/app/api/appointments/[id]/ics/route.ts"), "utf8");
    assert.ok(src.includes('guard("sales.read")'));
    assert.ok(src.includes("text/calendar"));
  });
});

describe("notifyAppointment", () => {
  test("fans out to in-app, email (with the .ics) and logs each outcome", async () => {
    configure();
    const calls = stubResend();
    mutate((d) => { d.notificationLog = []; d.opsNotifications = []; });

    const a = sample();
    const outcomes = await notifyAppointment(a, "booked");

    const inApp = outcomes.find((o) => o.channel === "in_app");
    assert.equal(inApp?.ok, true);
    const host = read().teamMembers.find((m) => m.name === "Sales Manager 1")!;
    const note = read().opsNotifications.at(-1)!;
    assert.equal(note.recipientId, host.id, "the assigned host is the in-app recipient");
    assert.equal(note.event, "appointment.booked");
    assert.match(note.title, /booked: Asha Rao/);

    const email = outcomes.find((o) => o.channel === "email");
    assert.equal(email?.ok, true, email?.detail);
    assert.deepEqual(calls[0].json.to, ["sales@test.invalid", "ops@test.invalid", host.email], "NOTIFY_EMAILS plus the host");
    assert.match(String(calls[0].json.subject), /Site visit booked: Asha Rao/);
    const att = (calls[0].json.attachments as Array<Record<string, string>>)[0];
    assert.equal(att.filename, "site-visit-apt_test1.ics");
    assert.ok(Buffer.from(att.content, "base64").toString().includes("DTSTART;TZID=Asia/Kolkata:20260906T100000"));

    // No customer record for that phone → WhatsApp is a logged skip, not a crash.
    const wa = outcomes.find((o) => o.channel === "whatsapp");
    assert.equal(wa?.ok, false);
    assert.match(wa!.detail, /no customer record/);

    const log = read().notificationLog.filter((n) => n.entityId === a.id);
    assert.deepEqual(log.map((n) => n.channel).sort(), ["email", "in_app", "whatsapp"]);
    assert.ok(log.every((n) => n.event === "appointment.booked"));
  });

  test("with no host and no email config, in-app broadcasts to sales managers and email says not configured", async () => {
    mutate((d) => { d.notificationLog = []; });
    const outcomes = await notifyAppointment(sample({ assignedTo: undefined }), "cancelled");
    assert.equal(read().opsNotifications.at(-1)!.recipientRole, "SALES_MANAGER");
    assert.equal(read().opsNotifications.at(-1)!.severity, "WARNING");
    const email = outcomes.find((o) => o.channel === "email")!;
    assert.equal(email.ok, false);
    assert.match(email.detail, /not configured/);
  });

  test("a visit the WhatsApp assistant booked is not confirmed twice", async () => {
    const orgId = defaultOrgId();
    const { upsertCustomer } = require("../src/lib/ops/customers") as typeof import("../src/lib/ops/customers");
    const { customer: c } = upsertCustomer({ orgId, phone: "919000022222", name: "Chat Buyer", source: "whatsapp" });
    // The buyer wrote in just now, so the 24h free-text window is open.
    mutate((d) => {
      d.notificationLog = [];
      d.opsMessages.push({
        id: "msg_in_chat", orgId, customerId: c.id, channel: "whatsapp", direction: "inbound",
        body: "Can I visit on Sunday?", authorType: "customer", createdAt: new Date().toISOString(),
      });
    });

    const a = sample({ id: "apt_chat", customerPhone: c.phone, channel: "whatsapp", createdBy: "ai" });
    const booked = await notifyAppointment(a, "booked");
    assert.match(booked.find((o) => o.channel === "whatsapp")!.detail, /assistant's reply/);

    // Later moves do reach the buyer (stub transport, so the send "succeeds").
    const moved = await notifyAppointment({ ...a, status: "rescheduled" }, "rescheduled");
    assert.equal(moved.find((o) => o.channel === "whatsapp")!.ok, true);
    const msg = read().opsMessages.filter((m) => m.customerId === c.id && m.direction === "outbound").at(-1)!;
    assert.equal(msg.tag, "appointment_rescheduled");
    assert.match(msg.body, /moved to/);
  });

  test("generic notify() with only an in-app payload writes one log row", async () => {
    mutate((d) => { d.notificationLog = []; });
    const out = await notify({
      orgId: defaultOrgId(), event: "test.ping", entity: "thing", entityId: "t1",
      inApp: { title: "Ping", body: "Pong", category: "ADMIN" },
    });
    assert.equal(out.length, 1);
    assert.equal(read().notificationLog.length, 1);
    assert.equal(read().notificationLog[0].event, "test.ping");
  });
});
