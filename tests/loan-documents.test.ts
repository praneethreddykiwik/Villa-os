import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { cleanup, isolate, samplePdf, seedTeam } from "./helpers";

/**
 * HOME-LOAN DOCUMENT CHECKLIST, END TO END
 *
 * WhatsApp chases documents → the CRM stores them → the loan officer is told.
 * Stub transport, isolated store: what is asserted is what the customer reads
 * and what the officer sees.
 */
const dir = isolate("loan-docs");
after(() => cleanup(dir));

const { read, mutate, resetToBootstrap } = require("../src/lib/db") as typeof import("../src/lib/db");
const { ensureOpsSeed, defaultOrgId } = require("../src/lib/ops/seed") as typeof import("../src/lib/ops/seed");
const { handleInbound, notifyDocumentDecision, runFollowUpTick } = require("../src/lib/ops/agent") as typeof import("../src/lib/ops/agent");
const { upsertCustomer, getCustomer, updateCustomer } = require("../src/lib/ops/customers") as typeof import("../src/lib/ops/customers");
const { activeCase, caseProgress, checklistFor, createLoanCase, defaultChecklist, getCase, setDefaultChecklist } =
  require("../src/lib/ops/loan") as typeof import("../src/lib/ops/loan");
const { reviewDocument } = require("../src/lib/ops/documents") as typeof import("../src/lib/ops/documents");
const { getConfig, updateConfig } = require("../src/lib/ops/config") as typeof import("../src/lib/ops/config");
const { dueFollowUps } = require("../src/lib/ops/followups") as typeof import("../src/lib/ops/followups");

let ORG = "";
before(() => {
  resetToBootstrap();
  ORG = defaultOrgId();
  ensureOpsSeed(ORG);
  seedTeam(ORG);
  // Quiet hours off and a generous daily cap so the cadence under test is the
  // follow-up schedule itself, not the time of day the suite happens to run.
  updateConfig(ORG, { messaging: { ...getConfig(ORG).messaging, quietHoursStart: 0, quietHoursEnd: 0, maxAutomatedPerDay: 50 } });
});

let n = 0;
const wamid = () => `wamid.LOAN${++n}`;
const outbound = (customerId: string) =>
  read().opsMessages.filter((m) => m.customerId === customerId && m.direction === "outbound").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const officerOf = (customerId: string) => read().teamMembers.find((m) => m.id === getCustomer(customerId)!.assignedLoanOfficerId)!;
const pdf = (marker: string) => ({ data: samplePdf(marker), mimeType: "application/pdf", filename: `${marker}.pdf` });

async function uploadAll(phone: string, loanCaseId: string): Promise<string[]> {
  const replies: string[] = [];
  for (const item of checklistFor(loanCaseId).filter((i) => i.required)) {
    const out = await handleInbound({ orgId: ORG, phone, body: "[document]", externalId: wamid(), type: "document", media: pdf(`${loanCaseId}-${item.documentType}`) });
    replies.push(out.reply ?? "");
  }
  return replies;
}

/* ========================================================================== */
describe("default checklist", () => {
  test("a new case gets the standard Indian home-loan set exactly once", () => {
    const { customer } = upsertCustomer({ orgId: ORG, phone: "+91 9700 0001", name: "Default One" });
    const { loanCase, created } = createLoanCase({ orgId: ORG, customerId: customer.id });
    assert.equal(created, true);
    const items = checklistFor(loanCase.id);
    const labels = items.map((i) => i.customerLabel);
    for (const want of [/aadhaar/i, /pan card/i, /passport-size photo/i, /address proof/i, /salary slips or itr/i, /bank statements/i, /form 16/i, /property documents/i, /existing loan/i]) {
      assert.ok(labels.some((l) => want.test(l)), `missing ${want}`);
    }
    assert.equal(items.filter((i) => i.required).length, 8);
    assert.equal(items.find((i) => /existing loan/i.test(i.customerLabel))!.required, false);
    assert.ok(items.every((i) => i.acceptedFormats.includes("pdf") && i.acceptedFormats.includes("jpg")));
    assert.equal(getCase(loanCase.id)!.status, "DOCUMENT_COLLECTION");

    // Opening again is idempotent and never duplicates the list.
    assert.equal(createLoanCase({ orgId: ORG, customerId: customer.id }).created, false);
    assert.equal(checklistFor(loanCase.id).length, items.length);
    assert.equal(read().auditEvents.filter((a) => a.action === "checklist.items_added" && a.entityId === loanCase.id).length, 1);
  });

  test("the default set is configurable per org and only affects new cases", () => {
    const before = defaultChecklist(ORG).items;
    const { customer: old } = upsertCustomer({ orgId: ORG, phone: "+91 9700 0002", name: "Before Edit" });
    const oldCase = createLoanCase({ orgId: ORG, customerId: old.id }).loanCase;

    setDefaultChecklist(ORG, [
      { documentType: "", customerLabel: "Aadhaar card", description: "Front and back", required: true, acceptedFormats: ["jpg", "png", "pdf"] },
      { documentType: "", customerLabel: "PAN card", description: "", required: true, acceptedFormats: [] },
      { documentType: "", customerLabel: "Passport-size photo", description: "", required: false, acceptedFormats: ["jpg"] },
    ]);
    const after = defaultChecklist(ORG).items;
    assert.equal(after.length, 3);
    assert.equal(after[1].acceptedFormats.join(","), "jpg,png,pdf", "empty formats fall back to the standard three");
    assert.equal(after[0].documentType, "aadhaar_card");

    const { customer: fresh } = upsertCustomer({ orgId: ORG, phone: "+91 9700 0003", name: "After Edit" });
    const freshCase = createLoanCase({ orgId: ORG, customerId: fresh.id }).loanCase;
    assert.equal(checklistFor(freshCase.id).length, 3);
    assert.equal(checklistFor(oldCase.id).length, before.length, "existing cases keep their list");

    setDefaultChecklist(ORG, before);
    assert.equal(defaultChecklist(ORG).items.length, before.length);
  });
});

/* ========================================================================== */
describe("WhatsApp document chase", () => {
  test("'I need a home loan' opens the case and lists the required documents (≤ 8 lines)", async () => {
    const phone = "+91 9711 0001";
    const out = await handleInbound({ orgId: ORG, phone, name: "Ravi Kumar", body: "Hi, I need a home loan for the 3BHK", externalId: wamid() });
    const loanCase = activeCase(out.customerId);
    assert.ok(loanCase, "a loan case must be opened");
    assert.equal(out.replyTag, "loan_opened", out.reply ?? "");
    const lines = out.reply!.split("\n").filter((l) => /^\d+\. /.test(l));
    assert.equal(lines.length, 8);
    assert.match(lines[0], /Aadhaar card/);
    assert.doesNotMatch(out.reply!, /existing loan/i, "optional items are not in the ask");
    assert.doesNotMatch(out.reply!, /approv|eligib/i);
    assert.ok(checklistFor(loanCase!.id).filter((i) => i.required).every((i) => i.status === "REQUESTED"));
    assert.ok(getCustomer(out.customerId)!.assignedLoanOfficerId, "an officer is assigned");

    // The reminder starts tomorrow, not now — the list was today's message.
    const reminder = read().followUps.find((f) => f.loanCaseId === loanCase!.id && f.kind === "DOCUMENT_REQUEST");
    assert.ok(reminder);
    assert.ok(new Date(reminder!.scheduledAt).getTime() > Date.now() + 12 * 3600_000);
    assert.equal(reminder!.maxAttempts, 5);
  });

  test("a plain EMI question does not open a case", async () => {
    const out = await handleInbound({ orgId: ORG, phone: "+91 9711 0002", name: "Curious", body: "Do you have EMI options?", externalId: wamid() });
    assert.equal(activeCase(out.customerId), undefined);
  });

  test("each upload is acknowledged with what is still needed; the last one completes the case and notifies the officer", async () => {
    const phone = "+91 9711 0003";
    const opened = await handleInbound({ orgId: ORG, phone, name: "Meena Iyer", body: "financing needed for the villa", externalId: wamid() });
    const customerId = opened.customerId;
    const loanCase = activeCase(customerId)!;
    const required = checklistFor(loanCase.id).filter((i) => i.required);

    const replies = await uploadAll(phone, loanCase.id);
    assert.match(replies[0], new RegExp(`got your ${required[0].customerLabel}`, "i"));
    assert.match(replies[0], /Still needed: /);
    const listed = replies[0].split("Still needed: ")[1].split(",").length;
    assert.ok(listed >= 1 && listed <= 3, replies[0]);
    assert.match(replies[0], new RegExp(required[1].customerLabel, "i"));
    assert.doesNotMatch(replies[0], /accepted/i, "received is not accepted");

    const last = replies[replies.length - 1];
    assert.match(last, /All documents received — our loan officer will review and call you/);

    const progress = caseProgress(loanCase.id);
    assert.equal(progress.allReceived, true);
    assert.equal(progress.missing.length, 0);
    assert.equal(progress.requiredAccepted, 0, "nothing is accepted until a human decides");
    assert.equal(getCase(loanCase.id)!.status, "READY_FOR_ANALYSIS");
    assert.ok(getCase(loanCase.id)!.readyForReviewAt);

    const officer = officerOf(customerId);
    const ready = read().opsNotifications.filter((x) => x.customerId === customerId && x.event === "loan_case.ready_for_analysis");
    assert.equal(ready.length, 1, "exactly one ready notification");
    assert.equal(ready[0].recipientId, officer.id);
    assert.match(ready[0].body, new RegExp(`/ops/loans/${loanCase.id}`), "the notification links to the case");

    // The reminder has nothing left to chase.
    const due = dueFollowUps(ORG, Date.now() + 3 * 86400_000);
    assert.ok(!due.due.some((d) => d.followUp.loanCaseId === loanCase.id));
  });

  test("'which documents do you need?' lists what is still missing at any time", async () => {
    const phone = "+91 9711 0004";
    const opened = await handleInbound({ orgId: ORG, phone, name: "Asha", body: "I want to apply for a loan", externalId: wamid() });
    const loanCase = activeCase(opened.customerId)!;
    const required = checklistFor(loanCase.id).filter((i) => i.required);
    await handleInbound({ orgId: ORG, phone, body: "[document]", externalId: wamid(), type: "document", media: pdf("asha-1") });
    const ask = await handleInbound({ orgId: ORG, phone, body: "Which documents do you still need from me?", externalId: wamid() });
    const lines = ask.reply!.split("\n").filter((l) => /^\d+\. /.test(l));
    assert.equal(lines.length, required.length - 1);
    assert.doesNotMatch(ask.reply!, new RegExp(`\\d+\\. ${required[0].customerLabel}`, "i"), "the received item is not asked for again");
  });

  test("an unreadable or wrong-type file is refused with the accepted formats", async () => {
    const phone = "+91 9711 0005";
    await handleInbound({ orgId: ORG, phone, name: "Wrong Type", body: "need a loan please", externalId: wamid() });
    const out = await handleInbound({
      orgId: ORG, phone, body: "[document]", externalId: wamid(), type: "document",
      media: { data: Buffer.from("PK not a document"), mimeType: "application/zip", filename: "docs.zip" },
    });
    assert.equal(out.replyTag, "media_failed");
    assert.match(out.reply!, /JPG, PNG, PDF/);
    assert.equal(out.documentId, undefined);
  });
});

/* ========================================================================== */
describe("officer review", () => {
  test("rejection re-chases over WhatsApp with the reason; acceptance of everything records the moment", async () => {
    const phone = "+91 9722 0001";
    const opened = await handleInbound({ orgId: ORG, phone, name: "Suresh", body: "I need financing", externalId: wamid() });
    const customerId = opened.customerId;
    const loanCase = activeCase(customerId)!;
    await uploadAll(phone, loanCase.id);
    const officer = officerOf(customerId);

    const first = checklistFor(loanCase.id)[0];
    const doc = read().documents.find((d) => d.id === first.currentDocumentId)!;
    const rejected = reviewDocument(doc.id, "REJECTED", { id: officer.id, type: "human" }, "The Aadhaar photo is blurred");
    assert.ok(rejected.ok);
    assert.equal(checklistFor(loanCase.id)[0].status, "REJECTED");
    assert.equal(getCase(loanCase.id)!.status, "DOCUMENTS_INCOMPLETE");

    const told = await notifyDocumentDecision(loanCase.id, first.id);
    assert.equal(told.sent, true, told.reason);
    const chase = outbound(customerId).at(-1)!;
    assert.match(chase.body, /clearer copy of your Aadhaar card/i);
    assert.match(chase.body, /blurred/);
    assert.ok(read().followUps.some((f) => f.checklistItemId === first.id && f.kind === "DOCUMENT_REJECTED" && f.status === "SCHEDULED"));

    // The replacement is attributed to the rejected item first.
    const again = await handleInbound({ orgId: ORG, phone, body: "[document]", externalId: wamid(), type: "document", media: pdf("suresh-aadhaar-2") });
    assert.match(again.reply!, /got your Aadhaar card/i);
    assert.equal(checklistFor(loanCase.id)[0].status, "UPLOADED");

    for (const item of checklistFor(loanCase.id).filter((i) => i.required)) {
      reviewDocument(item.currentDocumentId!, "ACCEPTED", { id: officer.id, type: "human" });
    }
    const c = getCase(loanCase.id)!;
    assert.equal(c.status, "READY_FOR_ANALYSIS");
    assert.ok(c.allDocumentsAcceptedAt);
    assert.equal(caseProgress(loanCase.id).completionPct, 100);
    assert.ok(read().opsNotifications.some((x) => x.customerId === customerId && x.event === "loan_case.documents_accepted"));
  });
});

/* ========================================================================== */
describe("daily reminder", () => {
  test("one gentle reminder a day, five at most, then escalation; opt-out and a closed window stop it", async () => {
    const phone = "+91 9733 0001";
    const opened = await handleInbound({ orgId: ORG, phone, name: "Quiet Customer", body: "we need a home loan", externalId: wamid() });
    const customerId = opened.customerId;
    const loanCase = activeCase(customerId)!;
    const reminder = () => read().followUps.find((f) => f.loanCaseId === loanCase.id && f.kind === "DOCUMENT_REQUEST")!;

    // Not due today.
    assert.ok(!dueFollowUps(ORG).due.some((d) => d.followUp.id === reminder().id));

    const DAY = 86400_000;
    const automated = () => outbound(customerId).filter((m) => m.automated).length;
    for (let day = 1; day <= 7; day++) {
      // Keep the window open (the customer wrote "yesterday") and the clock
      // one day further on: the follow-up's own schedule decides the rest.
      const now = Date.now() + day * DAY;
      mutate((d) => {
        for (const m of d.opsMessages.filter((x) => x.customerId === customerId && x.direction === "inbound")) m.createdAt = new Date(now - 2 * 3600_000).toISOString();
        const f = d.followUps.find((x) => x.id === reminder().id)!;
        if (f.status === "SCHEDULED") f.scheduledAt = new Date(Math.min(new Date(f.scheduledAt).getTime(), now)).toISOString();
      });
      const before = automated();
      await runFollowUpTick(ORG, now);
      const afterFirst = automated();
      assert.ok(afterFirst - before <= 1, `day ${day}: at most one reminder per tick`);
      // The store stamps the send with the real clock; align it with the simulated one.
      mutate((d) => {
        const latest = d.opsMessages.filter((m) => m.customerId === customerId && m.direction === "outbound" && m.automated).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (latest) latest.createdAt = new Date(now).toISOString();
      });
      // Two ticks the same day: the second one is throttled.
      await runFollowUpTick(ORG, now + 3600_000);
      assert.equal(automated(), afterFirst, `day ${day}: at most one reminder per day`);
    }
    assert.equal(automated(), 5, "stops after five reminders");
    assert.equal(reminder().status, "ESCALATED");
    assert.ok(read().escalations.some((e) => e.customerId === customerId && e.ruleId === "followups_exhausted"));
    const bodies = outbound(customerId).filter((m) => m.automated).map((m) => m.body);
    assert.equal(bodies.length, 5);
    assert.ok(bodies.every((b) => /Aadhaar card/i.test(b)), "each reminder names the next missing document");

    // A closed 24h window parks a document reminder instead of failing it.
    const { customer: silent } = upsertCustomer({ orgId: ORG, phone: "+91 9733 0002", name: "Silent" });
    const silentCase = createLoanCase({ orgId: ORG, customerId: silent.id }).loanCase;
    mutate((d) => {
      d.opsMessages.push({ id: "msg_silent", orgId: ORG, customerId: silent.id, channel: "whatsapp", direction: "inbound", body: "hi", authorType: "customer", createdAt: new Date(Date.now() - 3 * DAY).toISOString() } as never);
      d.followUps.push({ id: "fup_silent", orgId: ORG, customerId: silent.id, loanCaseId: silentCase.id, kind: "DOCUMENT_REQUEST", lane: "LOAN", scheduledAt: new Date(0).toISOString(), attempts: 0, maxAttempts: 5, status: "SCHEDULED", reason: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    });
    const parked = dueFollowUps(ORG);
    assert.ok(parked.skipped.some((s) => s.id === "fup_silent" && /24h window/.test(s.reason)));

    // Opt-out stops everything.
    updateCustomer(silent.id, { optedOut: true }, { type: "human" });
    mutate((d) => { d.opsMessages.find((m) => m.id === "msg_silent")!.createdAt = new Date().toISOString(); });
    const stopped = dueFollowUps(ORG);
    assert.ok(stopped.skipped.some((s) => s.id === "fup_silent" && /opted out/i.test(s.reason)));
  });
});
