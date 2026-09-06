import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { cleanup, isolate, samplePdf, seedTeam } from "./helpers";

/**
 * WHATSAPP CUSTOMER AGENT
 *
 * Every flow here runs under the isolated store with the stub transport: no
 * network, nothing sent. What is asserted is what the agent SAYS and what it
 * RECORDS — because the customer only ever sees the former and the team only
 * ever sees the latter.
 */
const dir = isolate("wa-agent");
after(() => cleanup(dir));

const { read, mutate, resetToBootstrap } = require("../src/lib/db") as typeof import("../src/lib/db");
const { ensureOpsSeed, defaultOrgId } = require("../src/lib/ops/seed") as typeof import("../src/lib/ops/seed");
const { handleInbound } = require("../src/lib/ops/agent") as typeof import("../src/lib/ops/agent");
const { parseWebhook, TOO_LARGE_ERROR } = require("../src/lib/platforms/whatsapp") as typeof import("../src/lib/platforms/whatsapp");
const { upsertCustomer, getCustomer } = require("../src/lib/ops/customers") as typeof import("../src/lib/ops/customers");
const { createLoanCase, applyChecklistTemplate, checklistFor } = require("../src/lib/ops/loan") as typeof import("../src/lib/ops/loan");
const { slots } = require("../src/lib/appointments/engine") as typeof import("../src/lib/appointments/engine");
const P = require("../src/lib/ai/provider") as typeof import("../src/lib/ai/provider");

let ORG = "";
let BRAND = "";
before(() => {
  resetToBootstrap();
  ORG = defaultOrgId();
  ensureOpsSeed(ORG);
  seedTeam(ORG);
  BRAND = read().brands[0].id;
  mutate((d) => {
    d.brands[0].offerings = ["3BHK garden villas", "4BHK lake-view villas"];
  });
});

let n = 0;
const wamid = () => `wamid.AGENT${++n}`;
const outbound = (customerId: string) =>
  read().opsMessages.filter((m) => m.customerId === customerId && m.direction === "outbound").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const escalations = (customerId: string) => read().escalations.filter((e) => e.customerId === customerId);
const png = (marker: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(marker)]);

/* ========================================================================== */
describe("pricing and availability", () => {
  test("pricing answers from brand offerings, quotes no figure, and offers a visit", async () => {
    const out = await handleInbound({ orgId: ORG, phone: "+91 9811 0001", name: "Priya", body: "What is the price of a 3 bedroom?", externalId: wamid() });
    assert.ok(out.reply);
    assert.match(out.reply!, /3BHK garden villas/);
    assert.match(out.reply!, /pricing/i);
    assert.match(out.reply!, /see it in person|site visit/i);
    assert.doesNotMatch(out.reply!, /₹|lakh|crore|\d+\s?%/i, "the assistant never quotes a number");
    assert.equal(out.replyTag, "pricing");
  });

  test("availability names offerings and offers a visit", async () => {
    const out = await handleInbound({ orgId: ORG, phone: "+91 9811 0002", name: "Arun", body: "Is anything available in March?", externalId: wamid() });
    assert.match(out.reply!, /available/i);
    assert.match(out.reply!, /4BHK lake-view villas/);
    assert.match(out.reply!, /site visit/i);
  });

  test("exactly one outbound per inbound", async () => {
    const phone = "+91 9811 0003";
    let customerId = "";
    for (const body of ["hello", "what does it cost?", "can I visit?"]) {
      customerId = (await handleInbound({ orgId: ORG, phone, name: "One", body, externalId: wamid() })).customerId;
    }
    assert.equal(outbound(customerId).length, 3);
  });
});

/* ========================================================================== */
describe("site visit booking", () => {
  test("proposes real slots from the appointments engine, then books on a numbered reply", async () => {
    const phone = "+91 9822 0001";
    const first = await handleInbound({ orgId: ORG, phone, name: "Visitor One", body: "Could I come for a site visit?", externalId: wamid() });
    assert.equal(first.replyTag, "visit_slots", first.reply ?? "");
    assert.match(first.reply!, /1\. /);
    const offered = outbound(first.customerId).at(-1)!;
    assert.ok(offered.meta?.slot1, "the offered slots must be recorded on the message, not only in prose");
    assert.ok(slots(BRAND, new Date().toISOString(), 7).some((s) => s.startsAt === offered.meta!.slot1), "slot 1 must be a real bookable slot");

    const second = await handleInbound({ orgId: ORG, phone, body: "1", externalId: wamid() });
    assert.equal(second.replyTag, "visit_booked", second.reply ?? "");
    assert.ok(second.appointmentId);
    const apt = read().appointments!.find((a) => a.id === second.appointmentId)!;
    assert.equal(apt.startsAt, offered.meta!.slot1);
    assert.equal(apt.channel, "whatsapp");
    assert.equal(apt.status, "confirmed");
  });

  test("a question that merely starts with a digit does not book a slot", async () => {
    const phone = "+91 9822 0009";
    const first = await handleInbound({ orgId: ORG, phone, name: "Visitor Nine", body: "Could I come for a site visit?", externalId: wamid() });
    assert.equal(first.replyTag, "visit_slots", first.reply ?? "");
    for (const body of ["2 bhk price?", "3 of us will come"]) {
      const out = await handleInbound({ orgId: ORG, phone, body, externalId: wamid() });
      assert.notEqual(out.replyTag, "visit_booked", `"${body}" must not book: ${out.reply ?? ""}`);
      assert.ok(!out.appointmentId, `"${body}" must not create an appointment`);
    }
    // A bare pick still books, even with trailing punctuation.
    const pick = await handleInbound({ orgId: ORG, phone, body: "Could I come for a site visit?", externalId: wamid() });
    assert.equal(pick.replyTag, "visit_slots", pick.reply ?? "");
    const booked = await handleInbound({ orgId: ORG, phone, body: "option 2.", externalId: wamid() });
    assert.equal(booked.replyTag, "visit_booked", booked.reply ?? "");
  });

  test("a callback or human request with a day word after a slot offer is not a slot refinement", async () => {
    const phone = "+91 9822 0010";
    const first = await handleInbound({ orgId: ORG, phone, name: "Visitor Ten", body: "Could I come for a site visit?", externalId: wamid() });
    assert.equal(first.replyTag, "visit_slots", first.reply ?? "");
    const cb = await handleInbound({ orgId: ORG, phone, body: "call me tomorrow", externalId: wamid() });
    assert.equal(cb.replyTag, "callback", cb.reply ?? "");
    assert.ok(escalations(cb.customerId).some((e) => e.ruleId === "callback_requested"));
    const human = await handleInbound({ orgId: ORG, phone, body: "I want to talk to a salesman today", externalId: wamid() });
    assert.equal(human.replyTag, "handoff", human.reply ?? "");
    assert.ok(escalations(human.customerId).some((e) => e.ruleId === "requested_human"));
  });

  test("an interactive button carrying slot:<iso> books directly", async () => {
    const iso = slots(BRAND, new Date().toISOString(), 7)[1].startsAt;
    const out = await handleInbound({
      orgId: ORG, phone: "+91 9822 0002", name: "Button Tapper", body: "Sunday 11am", externalId: wamid(),
      type: "interactive", interactive: { id: `slot:${iso}`, title: "Sunday 11am" },
    });
    assert.equal(out.replyTag, "visit_booked", out.reply ?? "");
    assert.ok(read().appointments!.some((a) => a.id === out.appointmentId && a.startsAt === iso));
  });

  test("records a follow-up instead of dead air when no slot is bookable", async () => {
    const { saveAvailability, availabilityFor } = require("../src/lib/appointments/engine") as typeof import("../src/lib/appointments/engine");
    const original = availabilityFor(BRAND);
    saveAvailability({ ...original, openHours: {} });
    try {
      const out = await handleInbound({ orgId: ORG, phone: "+91 9822 0003", name: "No Slots", body: "I want to visit the site", externalId: wamid() });
      assert.equal(out.replyTag, "visit_followup");
      assert.ok(read().followUps.some((f) => f.customerId === out.customerId && f.kind === "SALES_NUDGE" && f.status === "SCHEDULED"));
    } finally {
      saveAvailability(original);
    }
  });
});

/* ========================================================================== */
describe("inbound media", () => {
  test("an image from a customer with NO loan case is stored on the record and acknowledged", async () => {
    const out = await handleInbound({
      orgId: ORG, phone: "+91 9833 0001", name: "No Case", body: "[image]", externalId: wamid(),
      type: "image", media: { data: png("nocase"), mimeType: "image/png", filename: "IMG_1.png" },
    });
    assert.ok(out.documentId, "the file must be stored even without a loan case");
    const doc = read().documents.find((d) => d.id === out.documentId)!;
    assert.equal(doc.customerId, out.customerId);
    assert.equal(doc.checklistItemId, undefined);
    assert.equal(doc.loanCaseId, undefined);
    assert.equal(doc.status, "RECEIVED");
    assert.equal(out.replyTag, "media");
    assert.match(out.reply!, /received your photo/i);
    assert.doesNotMatch(out.reply!, /accepted/i);
    const inbound = read().opsMessages.find((m) => m.customerId === out.customerId && m.direction === "inbound")!;
    assert.equal(inbound.documentId, out.documentId, "the message row must point at the stored document");
  });

  test("with a loan case the file is attributed to the outstanding item and the next gap is named", async () => {
    const { customer } = upsertCustomer({ orgId: ORG, phone: "+91 9833 0002", name: "Has Case" });
    const { loanCase } = createLoanCase({ orgId: ORG, customerId: customer.id });
    applyChecklistTemplate(loanCase.id, "standard_home_loan", { type: "human" });
    const [firstItem, secondItem] = checklistFor(loanCase.id);

    const out = await handleInbound({
      orgId: ORG, phone: "+91 9833 0002", body: "[document]", externalId: wamid(),
      type: "document", media: { data: samplePdf("case"), mimeType: "application/pdf", filename: "id.pdf" },
    });
    assert.ok(out.documentId);
    assert.equal(read().documents.find((d) => d.id === out.documentId)!.checklistItemId, firstItem.id);
    assert.equal(checklistFor(loanCase.id)[0].status, "UPLOADED", "received, never accepted");
    assert.match(out.reply!, new RegExp(`(got|received) your ${firstItem.customerLabel}`, "i"));
    assert.match(out.reply!, new RegExp(secondItem.customerLabel, "i"), "the next missing item must be named");
    assert.doesNotMatch(out.reply!, /accepted|approved/i);
  });

  test("a redelivered file is recognised and not stored twice", async () => {
    const phone = "+91 9833 0003";
    const media = { data: png("dupe"), mimeType: "image/png", filename: "a.png" };
    const a = await handleInbound({ orgId: ORG, phone, name: "Dupe", body: "[image]", externalId: wamid(), type: "image", media });
    const b = await handleInbound({ orgId: ORG, phone, body: "[image]", externalId: wamid(), type: "image", media });
    assert.equal(a.documentId, b.documentId);
    assert.equal(read().documents.filter((d) => d.customerId === a.customerId).length, 1);
    assert.match(b.reply!, /already have/i);
  });

  test("two overlapping deliveries of the same externalId are handled once", async () => {
    // Media handling awaits storage before the inbound row exists; a retry
    // landing in that window must not produce a second row or a second reply.
    const phone = "+91 9833 0007";
    const id = wamid();
    const media = { data: png("race"), mimeType: "image/png", filename: "r.png" };
    const [a, b] = await Promise.all([
      handleInbound({ orgId: ORG, phone, name: "Race", body: "[image]", externalId: id, type: "image", media }),
      handleInbound({ orgId: ORG, phone, name: "Race", body: "[image]", externalId: id, type: "image", media }),
    ]);
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true);
    assert.equal(b.customerId, a.customerId);
    assert.equal(read().opsMessages.filter((m) => m.externalId === id).length, 1, "one inbound row");
    assert.equal(outbound(a.customerId).length, 1, "one reply");
    // A later redelivery still hits the stored-row check once the work is done.
    const c = await handleInbound({ orgId: ORG, phone, body: "[image]", externalId: id, type: "image", media });
    assert.equal(c.duplicate, true);
  });

  test("an oversized file is told it is too large, not asked to be resent", async () => {
    // Refused before download: fetchWhatsAppMedia hands back an empty body with the reason.
    const refused = { data: Buffer.alloc(0), mimeType: "application/pdf", filename: "big.pdf", error: TOO_LARGE_ERROR };
    const a = await handleInbound({ orgId: ORG, phone: "+91 9833 0008", name: "Big File", body: "[document]", externalId: wamid(), type: "document", media: refused });
    assert.equal(a.documentId, undefined);
    assert.equal(a.replyTag, "media_failed");
    assert.match(a.reply!, /too large/i);
    assert.match(a.reply!, /smaller|compressed/i);
    assert.doesNotMatch(a.reply!, /send it again/i);
    // Downloaded anyway (no size metadata) and rejected by validateUpload: same answer.
    const big = { data: Buffer.concat([png("big"), Buffer.alloc(16 * 1024 * 1024)]), mimeType: "image/png", filename: "big.png" };
    const b = await handleInbound({ orgId: ORG, phone: "+91 9833 0008", body: "[image]", externalId: wamid(), type: "image", media: big });
    assert.equal(b.replyTag, "media_failed");
    assert.match(b.reply!, /too large/i);
  });

  test("fetchWhatsAppMedia refuses from Graph metadata without downloading the body", async () => {
    const prevDriver = process.env.PLATFORM_DRIVER;
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    process.env.PLATFORM_DRIVER = "live";
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ url: "https://lookaside.example/blob", mime_type: "application/pdf", file_size: 100 * 1024 * 1024 }), { status: 200 });
    }) as typeof fetch;
    try {
      // DRIVER is read when platforms/types loads, so import fresh copies under the live driver.
      for (const m of ["../src/lib/platforms/whatsapp", "../src/lib/platforms/types"]) delete require.cache[require.resolve(m)];
      const { fetchWhatsAppMedia } = require("../src/lib/platforms/whatsapp") as typeof import("../src/lib/platforms/whatsapp");
      const out = await fetchWhatsAppMedia("media-1", "token", { filename: "big.pdf" });
      assert.equal(out?.error, TOO_LARGE_ERROR);
      assert.equal(out?.data.length, 0);
      assert.equal(calls.length, 1, "metadata only — the blob URL was never fetched");
    } finally {
      globalThis.fetch = realFetch;
      if (prevDriver === undefined) delete process.env.PLATFORM_DRIVER; else process.env.PLATFORM_DRIVER = prevDriver;
      for (const m of ["../src/lib/platforms/whatsapp", "../src/lib/platforms/types"]) delete require.cache[require.resolve(m)];
    }
  });

  test("an image that could not be downloaded is acknowledged honestly, not claimed", async () => {
    const out = await handleInbound({ orgId: ORG, phone: "+91 9833 0004", name: "Lost Media", body: "[image]", externalId: wamid(), type: "image" });
    assert.equal(out.documentId, undefined);
    assert.equal(out.replyTag, "media_failed");
    assert.match(out.reply!, /couldn't retrieve/i);
    assert.doesNotMatch(out.reply!, /received/i);
  });

  test("audio is acknowledged without transcription", async () => {
    const out = await handleInbound({ orgId: ORG, phone: "+91 9833 0005", name: "Voice", body: "[audio]", externalId: wamid(), type: "audio" });
    assert.equal(out.replyTag, "audio");
    assert.match(out.reply!, /can't listen|type/i);
  });

  test("a shared location is kept on the profile and acknowledged", async () => {
    const out = await handleInbound({
      orgId: ORG, phone: "+91 9833 0006", name: "Pin", body: "[location]", externalId: wamid(),
      type: "location", location: { latitude: 12.97, longitude: 77.59, name: "Home" },
    });
    assert.equal(out.replyTag, "location");
    assert.match(getCustomer(out.customerId)!.preferences.sharedLocation, /Home.*12\.97,77\.59/);
  });
});

/* ========================================================================== */
describe("non-message webhook types", () => {
  test("parseWebhook types a reaction and an unsupported notification explicitly", () => {
    const msg = (extra: Record<string, unknown>) => ({ id: `wamid.P${++n}`, from: "919877000001", timestamp: "1700000000", ...extra });
    const out = parseWebhook({
      entry: [{ changes: [{ value: { messages: [
        msg({ type: "reaction", reaction: { message_id: "wamid.ours", emoji: "👍" } }),
        msg({ type: "unsupported", errors: [{ code: 131051 }] }),
        msg({ type: "flow_reply_we_never_heard_of" }),
      ] } }] }],
    });
    assert.deepEqual(out.map((m) => [m.type, m.text]), [
      ["reaction", "[reaction] 👍"],
      ["unsupported", "[unsupported]"],
      ["unknown", "[flow_reply_we_never_heard_of]"],
    ]);
  });

  for (const type of ["reaction", "system", "unsupported"] as const) {
    test(`${type} is recorded but never answered`, async () => {
      const phone = `+91 9866 000${type.length}`;
      const out = await handleInbound({ orgId: ORG, phone, name: "Reactor", body: `[${type}]`, externalId: wamid(), type });
      assert.equal(out.reply, null);
      assert.equal(out.replyTag, undefined);
      assert.equal(outbound(out.customerId).length, 0);
      assert.match(out.silentReason!, new RegExp(type));
    });
  }
});

/* ========================================================================== */
describe("opt-out", () => {
  test("stop marks the customer out, confirms once, then stays silent", async () => {
    const phone = "+91 9844 0001";
    const stop = await handleInbound({ orgId: ORG, phone, name: "Leaver", body: "please stop", externalId: wamid() });
    assert.equal(getCustomer(stop.customerId)!.optedOut, true);
    assert.equal(stop.replyTag, "opt_out");
    const later = await handleInbound({ orgId: ORG, phone, body: "what is the price?", externalId: wamid() });
    assert.equal(later.reply, null);
    assert.match(later.silentReason ?? "", /opted out/i);
    assert.equal(outbound(stop.customerId).length, 1);
  });

  test("START after an opt-out re-engages the customer and is answered", async () => {
    const phone = "+91 9844 0003";
    const stop = await handleInbound({ orgId: ORG, phone, name: "Returner", body: "STOP", externalId: wamid() });
    assert.equal(getCustomer(stop.customerId)!.optedOut, true);
    assert.match(stop.reply ?? "", /reply START/);
    const back = await handleInbound({ orgId: ORG, phone, body: "Actually I'd like to continue, please start again", externalId: wamid() });
    assert.equal(getCustomer(back.customerId)!.optedOut, false);
    assert.notEqual(back.silentReason, "Customer opted out");
    assert.ok(back.reply, "re-opt-in message is answered");
    assert.ok(read().auditEvents.some((a) => a.action === "customer.opted_in" && a.customerId === stop.customerId));
  });

  test("a document caption containing 'stop' is not an opt-out", async () => {
    const out = await handleInbound({
      orgId: ORG, phone: "+91 9844 0002", name: "Caption", body: "bus stop view from the plot", externalId: wamid(),
      type: "image", media: { data: png("caption"), mimeType: "image/png", filename: "view.png" },
    });
    assert.equal(getCustomer(out.customerId)!.optedOut, false);
  });
});

/* ========================================================================== */
describe("unknown messages and human-only subjects", () => {
  test("clarifies once, escalates on the second consecutive unknown", async () => {
    const phone = "+91 9855 0001";
    const a = await handleInbound({ orgId: ORG, phone, name: "Puzzler", body: "xq zzt plorf", externalId: wamid() });
    assert.equal(a.replyTag, "clarify", a.reply ?? "");
    assert.match(a.reply!, /pricing, availability, a site visit, or financing/i);
    assert.equal(escalations(a.customerId).length, 0);

    const b = await handleInbound({ orgId: ORG, phone, body: "blorp fnargle", externalId: wamid() });
    assert.equal(b.replyTag, "handoff", b.reply ?? "");
    assert.ok(escalations(b.customerId).some((e) => e.ruleId === "ai_unknown" && e.status === "OPEN"));
  });

  test("price negotiation escalates and the assistant does not negotiate", async () => {
    const out = await handleInbound({ orgId: ORG, phone: "+91 9855 0002", name: "Haggler", body: "Can you give a discount on the 4BHK?", externalId: wamid() });
    assert.ok(escalations(out.customerId).some((e) => e.ruleId === "price_negotiation"));
    assert.equal(out.replyTag, "handoff");
    assert.match(out.reply!, /can't negotiate/i);
  });

  test("legal terms escalate", async () => {
    const out = await handleInbound({ orgId: ORG, phone: "+91 9855 0003", name: "Careful", body: "What does the RERA registration and stamp duty look like?", externalId: wamid() });
    assert.ok(escalations(out.customerId).some((e) => e.ruleId === "legal_question"));
    assert.match(out.reply!, /legal question/i);
  });

  test("approval questions never reach the model and never speculate", async () => {
    const out = await handleInbound({ orgId: ORG, phone: "+91 9855 0004", name: "Hopeful", body: "Will I get approved for the loan?", externalId: wamid() });
    assert.equal(out.replyTag, "approval");
    assert.match(out.reply!, /can't give you a view on approval/i);
  });
});

/* ========================================================================== */
describe("LLM layer (stubbed provider)", () => {
  const realComplete = P.complete;
  let calls = 0;
  const stub = (impl: () => Promise<string | null>) => {
    calls = 0;
    (P as { complete: typeof P.complete }).complete = async (opts) => {
      calls += 1;
      assert.ok((opts.maxTokens ?? 9999) <= 300, "free-tier budget: max_tokens ≤ 300");
      assert.equal(opts.timeoutMs, 8_000);
      assert.ok((opts.temperature ?? 1) <= 0.3);
      return impl();
    };
  };
  before(() => { process.env.GROQ_API_KEY = "test-key-never-used"; });
  after(() => { delete process.env.GROQ_API_KEY; (P as { complete: typeof P.complete }).complete = realComplete; });

  test("a good completion is sent, grounded in the prompt's brand facts", async () => {
    let seenSystem = "";
    (P as { complete: typeof P.complete }).complete = async (opts) => {
      // extractInsight also calls complete(); only the reply prompt carries FACTS.
      if (/FACTS/.test(opts.system)) { seenSystem = opts.system; return "Happy to help — our 3BHK garden villas are popular. Would you like to visit this week?"; }
      return null;
    };
    const out = await handleInbound({ orgId: ORG, phone: "+91 9866 0001", name: "LLM One", body: "tell me about the garden villas", externalId: wamid() });
    assert.equal(out.replyTag, "llm", out.reply ?? "");
    assert.match(out.reply!, /garden villas/);
    assert.match(seenSystem, /3BHK garden villas/, "brand offerings must be in the system prompt");
    assert.match(seenSystem, /never state or estimate a price/i);
  });

  test("a throwing provider falls back to the deterministic reply — the customer is still answered", async () => {
    stub(async () => { throw new Error("429 rate limited"); });
    const out = await handleInbound({ orgId: ORG, phone: "+91 9866 0002", name: "LLM Two", body: "What is the price?", externalId: wamid() });
    assert.equal(out.replyTag, "pricing");
    assert.match(out.reply!, /confirm current pricing/i);
    assert.ok(calls >= 1);
  });

  test("a null completion (provider chain exhausted) falls back too", async () => {
    stub(async () => null);
    const out = await handleInbound({ orgId: ORG, phone: "+91 9866 0003", name: "LLM Three", body: "hello there", externalId: wamid() });
    assert.equal(out.replyTag, "greeting");
    assert.ok(out.reply);
  });

  test("ESCALATE from the model becomes a human escalation, not a made-up answer", async () => {
    stub(async () => "ESCALATE");
    const out = await handleInbound({ orgId: ORG, phone: "+91 9866 0004", name: "LLM Four", body: "Do you allow pets in the clubhouse?", externalId: wamid() });
    assert.equal(out.replyTag, "handoff");
    assert.ok(escalations(out.customerId).some((e) => e.ruleId === "ai_unknown"));
  });

  test("a completion that drifts into prices or approval is discarded", async () => {
    stub(async () => "Sure! It's about 2.5 crore and you'll definitely get approved.");
    const out = await handleInbound({ orgId: ORG, phone: "+91 9866 0005", name: "LLM Five", body: "how much roughly?", externalId: wamid() });
    assert.equal(out.replyTag, "pricing");
    assert.doesNotMatch(out.reply!, /crore|approved/i);
  });

  test("bounded paths bypass the model entirely", async () => {
    stub(async () => "I should never be sent");
    const before = calls;
    const out = await handleInbound({ orgId: ORG, phone: "+91 9866 0006", name: "LLM Six", body: "Any discount if I pay upfront?", externalId: wamid() });
    assert.equal(out.replyTag, "handoff");
    assert.doesNotMatch(out.reply!, /never be sent/);
    // extractInsight may call once; the reply path must not add a second call.
    assert.ok(calls - before <= 1);
  });
});

/* ========================================================================== */
describe("24-hour service window", () => {
  test("outside the window nothing is sent; the reply is queued and a person is told", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600_000).toISOString();
    const out = await handleInbound({ orgId: ORG, phone: "+91 9877 0001", name: "Late", body: "what is the price?", externalId: wamid(), receivedAt: twoDaysAgo });
    assert.equal(out.requiresTemplate, true);
    assert.ok(out.reply, "a reply was composed…");
    assert.equal(outbound(out.customerId).length, 0, "…but no outbound message was recorded as sent");
    const queued = read().followUps.find((f) => f.customerId === out.customerId && f.kind === "TEMPLATE_REQUIRED");
    assert.ok(queued, "the words are kept as a follow-up");
    assert.equal(queued!.message, out.reply);
    assert.ok(escalations(out.customerId).some((e) => e.ruleId === "window_closed"));
    assert.ok(read().auditEvents.some((a) => a.customerId === out.customerId && a.action === "message.send_failed" && a.metadata.requiresTemplate === true));
  });

  test("the queued reply goes out once the customer writes again and reopens the window", async () => {
    const { runFollowUpTick } = require("../src/lib/ops/agent") as typeof import("../src/lib/ops/agent");
    const phone = "+91 9877 0002";
    const stale = await handleInbound({ orgId: ORG, phone, name: "Returner", body: "hello", externalId: wamid(), receivedAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString() });
    assert.equal(stale.requiresTemplate, true);
    await handleInbound({ orgId: ORG, phone, body: "hi again", externalId: wamid() });
    // Tick well after any quiet-hours shift, at a daytime IST hour, so only the
    // window check decides. The window itself is evaluated against real time.
    const later = new Date(Date.now() + 2 * 24 * 3600_000); later.setUTCHours(7, 0, 0, 0);
    const tick = await runFollowUpTick(ORG, later.getTime());
    const queued = read().followUps.find((f) => f.customerId === stale.customerId && f.kind === "TEMPLATE_REQUIRED")!;
    assert.ok(["SENT", "COMPLETED"].includes(queued.status), `follow-up was ${queued.status}; tick=${JSON.stringify(tick)}`);
  });

  test("while the window stays closed the queued reply is skipped, not retried, on every tick", async () => {
    const { runFollowUpTick } = require("../src/lib/ops/agent") as typeof import("../src/lib/ops/agent");
    const stale = await handleInbound({ orgId: ORG, phone: "+91 9877 0004", name: "Ghost", body: "hello", externalId: wamid(), receivedAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString() });
    assert.equal(stale.requiresTemplate, true);
    const audits = () => read().auditEvents.filter((a) => a.customerId === stale.customerId && a.action === "message.send_failed").length;
    const before = audits();
    const later = new Date(Date.now() + 2 * 24 * 3600_000); later.setUTCHours(7, 0, 0, 0);
    for (let i = 0; i < 5; i++) {
      const tick = await runFollowUpTick(ORG, later.getTime() + i * 300_000);
      assert.equal(tick.failed, 0, `tick ${i} should not attempt a send: ${JSON.stringify(tick)}`);
      assert.ok(tick.skipped.some((s) => s.reason === "24h window closed"));
    }
    assert.equal(audits(), before, "no send_failed audit rows are written while the window is closed");
    const queued = read().followUps.find((f) => f.customerId === stale.customerId && f.kind === "TEMPLATE_REQUIRED")!;
    assert.equal(queued.status, "SCHEDULED");
    assert.equal(queued.attempts, 0);
  });

  test("a queued reply goes out before the answer to the newer message, and a slot pick still books", async () => {
    const { runFollowUpTick } = require("../src/lib/ops/agent") as typeof import("../src/lib/ops/agent");
    const phone = "+91 9877 0004";
    const stale = await handleInbound({ orgId: ORG, phone, name: "Ordered", body: "what is the price?", externalId: wamid(), receivedAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString() });
    assert.equal(stale.requiresTemplate, true);
    const fresh = await handleInbound({ orgId: ORG, phone, body: "can I visit?", externalId: wamid() });
    assert.equal(fresh.replyTag, "visit_slots", fresh.reply ?? "");
    // The owed pricing answer landed first, then the slot offer — in order.
    assert.deepEqual(outbound(stale.customerId).map((m) => m.tag), ["queued_reply", "visit_slots"]);
    const queued = read().followUps.find((f) => f.customerId === stale.customerId && f.kind === "TEMPLATE_REQUIRED")!;
    assert.ok(["SENT", "COMPLETED"].includes(queued.status), `follow-up was ${queued.status}`);
    // The tick has nothing left to send for this customer.
    const later = new Date(Date.now() + 2 * 24 * 3600_000); later.setUTCHours(7, 0, 0, 0);
    await runFollowUpTick(ORG, later.getTime());
    assert.equal(outbound(stale.customerId).length, 2);
    const pick = await handleInbound({ orgId: ORG, phone, body: "1", externalId: wamid() });
    assert.equal(pick.replyTag, "visit_booked", pick.reply ?? "");
    assert.ok(pick.appointmentId);
  });

  test("a follow-up blocked by the window does not spawn another follow-up", async () => {
    const before = read().followUps.filter((f) => f.kind === "TEMPLATE_REQUIRED").length;
    const { deliver } = require("../src/lib/ops/agent") as typeof import("../src/lib/ops/agent");
    const { customer } = upsertCustomer({ orgId: ORG, phone: "+91 9877 0003", name: "Quiet" });
    const res = await deliver(ORG, customer.id, "reminder", "ai", undefined, { automated: true });
    assert.equal(res.requiresTemplate, true);
    assert.equal(read().followUps.filter((f) => f.kind === "TEMPLATE_REQUIRED").length, before);
  });
});

/* ========================================================================== */

describe("LLM output guard vocabulary", () => {
  const { isForbiddenReply } = require("../src/lib/ops/agent") as typeof import("../src/lib/ops/agent");

  test("figures, currency symbols and percentages are caught regardless of word boundaries", () => {
    for (const s of [
      "Prices start at ₹9500000",
      "It is $500000",
      "We can do 10% off for you",
      "Rs 95,00,000 onwards",
      "Rs. 45 lakh onwards",
      "INR 2.5 cr only",
      "around 2.5 crore",
      "you will definitely get approved",
    ]) assert.ok(isForbiddenReply(s), s);
  });

  test("asserted actions no tool performed are caught (§32)", () => {
    for (const s of [
      "Great, you're booked for tomorrow 10am.",
      "I have reserved the unit for you.",
      "Your visit is confirmed.",
      "We have put the unit on hold for you.",
    ]) assert.ok(isForbiddenReply(s), s);
  });

  test("credential requests, foreign links and action stems are caught", () => {
    for (const s of [
      "Please share your Aadhaar number and OTP here so I can reserve the unit.",
      "Pay the token at https://evil.example/pay now. Shall I arrange a callback?",
      "Send your card details and PIN to proceed.",
      "I have blocked the unit for you.",
      "I'll hold it till Friday.",
      "See www.example.org/brochure for the plan.",
    ]) assert.ok(isForbiddenReply(s), s);
    assert.ok(isForbiddenReply("Details at https://evil.example/x", undefined, "https://brand.example"));
    assert.ok(!isForbiddenReply("Details at https://www.brand.example/villas.", undefined, "https://brand.example"));
    assert.ok(!isForbiddenReply("Your pin code helps us pick the nearest site.", undefined));
  });

  test("ordinary sales replies pass", () => {
    for (const s of [
      "Happy to help — our 3BHK garden villas are popular. Would you like to visit this week?",
      "A colleague will confirm current pricing with you shortly.",
      "The clubhouse has a pool and a gym; shall I book a site visit?",
      "Our units are 3BHK and 4BHK with 5 minutes to the metro.",
    ]) assert.ok(!isForbiddenReply(s), s);
  });
});
