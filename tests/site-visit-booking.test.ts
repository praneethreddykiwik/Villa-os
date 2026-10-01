import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";

import { humanSlot, wallClockToUtc, zonedDatePart } from "../src/lib/osf/site-visit-booking";

/**
 * Answering a site-visit request.
 *
 * The expensive failure is not a crash. It is telling somebody who was about
 * to buy a house that they were rejected, or confirming a visit for a time
 * nobody agreed, or moving the diary and never telling the customer.
 */

// The suite is compiled into .test-build/ before it runs, so __dirname points
// there rather than at the sources these assertions read.
const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const LIB = "src/lib/osf/site-visit-booking.ts";
const ROUTE = "src/app/api/osf/site-visits/respond/route.ts";
const PAGE = "src/app/(app)/inbox/whatsapp/sales/site-visits/page.tsx";
const BELL = "src/components/visit-requests-bell.tsx";

describe("nobody is ever told they were rejected", () => {
  const src = read(LIB);

  test("there is no reject or decline path at all", () => {
    assert.match(src, /export async function offerAlternativeSlot/);
    assert.doesNotMatch(src, /export async function (reject|decline)/i);
  });

  test("the customer-facing wording never says it", () => {
    const messages = src.match(/const body =[\s\S]*?;/g)?.join(" ") ?? "";
    assert.ok(messages.length > 0, "expected outbound message bodies");
    assert.doesNotMatch(messages, /reject|decline|refus|unfortunately|unable to|cannot accommodate/i);
  });

  test("an alternative always names a concrete time", () => {
    // "That time does not work" leaves the customer to start again. A named
    // time lets them simply agree.
    const fn = src.slice(src.indexOf("export async function offerAlternativeSlot"));
    assert.match(fn, /proposedAtIso: string/);
    assert.match(fn, /Would \$\{slot\} suit you instead\?/);
  });

  test("it invites a counter-offer rather than closing the conversation", () => {
    const fn = src.slice(src.indexOf("export async function offerAlternativeSlot"));
    assert.match(fn, /another time works better/i);
  });

  test("the route refuses an answer with no time", () => {
    const src = read(ROUTE);
    assert.match(src, /if \(!when\)/);
    assert.match(src, /leaves them nowhere to go/);
  });
});

describe("the diary and the customer cannot disagree", () => {
  const src = read(LIB);

  test("confirming writes the real appointment time, not the requested one", () => {
    // preferred_* is only ever what was asked for; the rest of the app reads
    // scheduled_at.
    const fn = src.slice(src.indexOf("export async function confirmSiteVisit"), src.indexOf("export async function offerAlternativeSlot"));
    assert.match(fn, /status: "confirmed", scheduled_at: input\.scheduledAtIso/);
  });

  test("an offered time does not become a confirmed booking", () => {
    // The customer has not agreed yet; marking it scheduled would put an
    // appointment in the diary nobody confirmed.
    const fn = src.slice(src.indexOf("export async function offerAlternativeSlot"));
    assert.match(fn, /status: "requested"/);
    assert.doesNotMatch(fn.slice(0, fn.indexOf("const slot")), /status: "confirmed"/);
  });

  test("a failed WhatsApp does not lose the status change", () => {
    assert.match(src, /let messaged = true;/);
    assert.match(src, /messaged = false;/);
  });

  test("and the desk is told when the customer was not reached", () => {
    const route = read(ROUTE);
    assert.match(route, /if \(!result\.messaged\) url\.searchParams\.set\("unsent", "1"\)/);
  });

  test("a visit with no phone number is refused rather than half-done", () => {
    assert.match(src, /the lead has no phone number/);
  });

  test("logging can never fail the answer", () => {
    const calls = src.match(/await logActivity\([\s\S]*?\}\)\.catch\(\(\) => \{\}\);/g) ?? [];
    assert.equal(calls.length, 2, "both outcomes must log, and neither may throw");
  });
});

describe("the time the customer reads", () => {
  test("it is a date a person recognises, not an ISO string", async () => {
    const slot = await humanSlot(new Date("2026-10-05T18:00:00+05:30").toISOString());
    assert.match(slot, /Monday 5 October/);
    assert.match(slot, /6:00\s*pm/i);
  });

  test("it is rendered in the business's own time zone", () => {
    // Formatting in the server's zone would confirm visits for the wrong hour.
    const src = read(LIB);
    assert.match(src, /timeZone: settings\.callingTimeZone/);
  });

  test("an unparseable time is refused before anything is written", () => {
    const src = read(ROUTE);
    assert.match(src, /if \(!at\) return fail\("That is not a time we could read\."\);/);
    const at = src.indexOf("if (!at)");
    assert.ok(at > 0 && at < src.indexOf("confirmSiteVisit("), "the check must precede the write");
  });

  test("a wall-clock time is read in the business zone, not the server's", async () => {
    // The manager picks 18:00. `new Date("2026-10-05T18:00")` reads that as
    // the RUNTIME's local time — UTC on the server — so the visit was stored
    // as 18:00Z and the customer was told 11:30 pm.
    const utc = wallClockToUtc("2026-10-05T18:00", "Asia/Kolkata");
    assert.ok(utc, "expected a parsed instant");
    assert.equal(utc!.toISOString(), "2026-10-05T12:30:00.000Z");
    assert.match(await humanSlot(utc!.toISOString()), /6:00\s*pm/i);
  });

  test("the route parses against the configured zone rather than hardcoding one", () => {
    const src = read(ROUTE);
    assert.match(src, /wallClockToUtc\(when, settings\.callingTimeZone\)/);
  });

  test("a zone that observes DST is handled, not just India", () => {
    // 2:30am does not exist in New York on the spring-forward day; a naive
    // offset lookup lands an hour out.
    const utc = wallClockToUtc("2026-03-08T02:30", "America/New_York");
    assert.ok(utc);
    assert.equal(utc!.toISOString(), "2026-03-08T06:30:00.000Z");
  });

  test("rubbish is refused rather than silently becoming a date", () => {
    for (const bad of ["", "   ", "not a date", "2026-13-45T99:99", "2026-02-30T10:00", "2026-04-31T10:00"]) {
      assert.equal(wallClockToUtc(bad, "Asia/Kolkata"), null, `accepted ${JSON.stringify(bad)}`);
    }
  });

  test("the prefill date comes from the business zone", () => {
    // Slicing the ISO string takes the UTC date, so anything after 18:30 UTC
    // pre-filled the previous day.
    assert.equal(zonedDatePart("2026-10-05T20:00:00.000Z", "Asia/Kolkata"), "2026-10-06");
  });
});

describe("the request cannot go unnoticed", () => {
  test("pending requests are counted for the header", () => {
    const src = read(LIB);
    assert.match(src, /export async function pendingVisitRequests/);
    assert.match(src, /\.eq\("status", "requested"\)/);
  });

  test("a failed count never breaks the page it sits on", () => {
    const src = read(LIB);
    const fn = src.slice(src.indexOf("export async function pendingVisitRequests"));
    assert.match(fn, /catch \{[\s\S]*?return 0;/);
  });

  test("the bell links to the screen that answers them", () => {
    assert.match(read(BELL), /href="\/inbox\/whatsapp\/sales\/site-visits"/);
  });

  test("the badge is hidden when nothing is waiting", () => {
    assert.match(read(BELL), /\{waiting && \(/);
  });

  test("the header no longer advertises the deployment", () => {
    // "Live Infrastructure" linking to /setup is a vendor concern shown on
    // every screen of a product handed to a client.
    // Comments are stripped first: the note explaining why the badge went
    // names it, and a test that trips over its own explanation is noise.
    const shell = read("src/components/shell.tsx")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(shell, /Live Infrastructure/);
    assert.doesNotMatch(shell, /href="\/setup"/);
  });
});

describe("the desk answers from the request itself", () => {
  const src = read(PAGE);

  test("the panel only appears on a request", () => {
    assert.match(src, /visit\.status === "requested" && <RespondToRequest/);
  });

  test("confirming defaults to the time the customer asked for", () => {
    // Retyping a time you were given is how a typo reaches an appointment.
    assert.match(src, /visit\.preferred_date/);
    assert.match(src, /visit\.preferred_time/);
  });

  test("both answers are one form, so the time field serves either", () => {
    assert.match(src, /name="action" value="confirm"/);
    assert.match(src, /name="action" value="alternative"/);
  });
});
