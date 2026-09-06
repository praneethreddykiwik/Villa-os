import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { cleanup, isolate, samplePdf, seedTeam } from "./helpers";

const dir = isolate("workflow");
after(() => cleanup(dir));

/* Imports must follow isolate() so the store points at the temp directory. */
const { read, resetToBootstrap } = require("../src/lib/db") as typeof import("../src/lib/db");
const { ensureOpsSeed, defaultOrgId } = require("../src/lib/ops/seed") as typeof import("../src/lib/ops/seed");
const { upsertCustomer, getCustomer, setControl, updateCustomer, normalisePhone } =
  require("../src/lib/ops/customers") as typeof import("../src/lib/ops/customers");
const { handleInbound, runFollowUpTick, notifyDocumentDecision } =
  require("../src/lib/ops/agent") as typeof import("../src/lib/ops/agent");
const { computeScore, rescoreCustomer } = require("../src/lib/ops/scoring") as typeof import("../src/lib/ops/scoring");
const { createLoanCase, applyChecklistTemplate, checklistFor, caseProgress, getCase, updateChecklistItem } =
  require("../src/lib/ops/loan") as typeof import("../src/lib/ops/loan");
const { receiveDocument, reviewDocument } = require("../src/lib/ops/documents") as typeof import("../src/lib/ops/documents");
const { assign, workload } = require("../src/lib/ops/assignment") as typeof import("../src/lib/ops/assignment");
const { dueFollowUps, createFollowUp, nextSendableTime, escalate } =
  require("../src/lib/ops/followups") as typeof import("../src/lib/ops/followups");
const { getConfig, updateConfig } = require("../src/lib/ops/config") as typeof import("../src/lib/ops/config");
const { TOOLS } = require("../src/lib/ops/tools") as typeof import("../src/lib/ops/tools");
const { signDocumentRef, verifyDocumentRef, validateUpload } =
  require("../src/lib/ops/storage") as typeof import("../src/lib/ops/storage");
const { deterministicExtract, sentimentTrend, recordSentiment } =
  require("../src/lib/ops/intelligence") as typeof import("../src/lib/ops/intelligence");
const { rateLimit, resetLimit } = require("../src/lib/ops/ratelimit") as typeof import("../src/lib/ops/ratelimit");

let ORG = "";
before(() => {
  resetToBootstrap();
  ORG = defaultOrgId();
  ensureOpsSeed(ORG);
  seedTeam(ORG);
});

const members = () => read().teamMembers.filter((m) => m.orgId === ORG);
const salesManagers = () => members().filter((m) => m.role === "SALES_MANAGER");
const loanOfficers = () => members().filter((m) => m.role === "LOAN_OFFICER");

/* ========================================================================== */
describe("customer identity", () => {
  test("creates a customer and is idempotent by phone", () => {
    const a = upsertCustomer({ orgId: ORG, phone: "+91 90000 11111", name: "Test One" });
    const b = upsertCustomer({ orgId: ORG, phone: "919000011111", name: "Different Format" });
    assert.equal(a.created, true);
    assert.equal(b.created, false, "differently-formatted same number must not fork the profile");
    assert.equal(a.customer.id, b.customer.id);
  });

  test("does not overwrite a corrected name with a WhatsApp profile name", () => {
    const { customer } = upsertCustomer({ orgId: ORG, phone: "+91 90000 22222", name: "Original" });
    updateCustomer(customer.id, { name: "Corrected By Human" }, { type: "human" });
    upsertCustomer({ orgId: ORG, phone: "+91 90000 22222", name: "Whatsapp Name" });
    assert.equal(getCustomer(customer.id)!.name, "Corrected By Human");
  });

  test("normalises phone formats consistently", () => {
    assert.equal(normalisePhone("+91 (90000) 33333"), normalisePhone("09190000 33333".replace("091", "91")));
  });
});

/* ========================================================================== */
describe("lead scoring", () => {
  test("is deterministic and every point is attributable", () => {
    const a = computeScore(ORG, { askedPricing: true, requestedVisit: true, sentiment: "POSITIVE" });
    const b = computeScore(ORG, { askedPricing: true, requestedVisit: true, sentiment: "POSITIVE" });
    assert.deepEqual(a, b);
    assert.equal(a.score, a.contributions.reduce((s, c) => s + c.points, 0));
    assert.ok(a.contributions.some((c) => c.signal === "asked_pricing"));
  });

  test("respects configuration changes", () => {
    const before = computeScore(ORG, { askedPricing: true }).score;
    const cfg = getConfig(ORG);
    updateConfig(ORG, {
      scoring: {
        ...cfg.scoring,
        rules: cfg.scoring.rules.map((r) => (r.id === "asked_pricing" ? { ...r, points: 40 } : r)),
      },
    });
    assert.equal(computeScore(ORG, { askedPricing: true }).score, 40);
    updateConfig(ORG, { scoring: cfg.scoring });
    assert.equal(computeScore(ORG, { askedPricing: true }).score, before);
  });

  test("clamps to 0..100 and penalises staleness", () => {
    assert.equal(computeScore(ORG, { notInterested: true }).score, 0);
    const fresh = computeScore(ORG, { requestedHuman: true, requestedVisit: true }).score;
    const stale = computeScore(ORG, { requestedHuman: true, requestedVisit: true, daysSinceContact: 30 }).score;
    assert.ok(stale < fresh, "a stale lead must not outrank a live one");
  });
});

/* ========================================================================== */
describe("conversation intelligence", () => {
  test("extracts intent and signals without a model", () => {
    const out = deterministicExtract({
      orgId: ORG,
      customerId: "x",
      messages: [{ direction: "inbound", body: "What is the price? Can I book a site visit?", createdAt: new Date().toISOString() }],
    });
    assert.equal(out.intent, "HIGH_INTENT");
    assert.ok(out.buyingSignals.includes("Asked about pricing"));
    assert.equal(out.deterministic, true);
  });

  test("detects an explicit request for a human", () => {
    const out = deterministicExtract({
      orgId: ORG,
      customerId: "x",
      messages: [{ direction: "inbound", body: "Can someone call me please", createdAt: new Date().toISOString() }],
    });
    assert.equal(out.requestedHuman, true);
    assert.equal(out.intent, "HUMAN_HELP_REQUIRED");
  });

  test("sentiment history produces a trend", () => {
    const { customer } = upsertCustomer({ orgId: ORG, phone: "+91 90000 44444", name: "Trend Test" });
    for (const s of ["NEGATIVE", "NEUTRAL", "POSITIVE", "VERY_POSITIVE"] as const) {
      recordSentiment({ orgId: ORG, customerId: customer.id, sentiment: s, confidence: 0.8, intent: "EXPLORING", reason: "test" });
    }
    assert.equal(sentimentTrend(customer.id), "IMPROVING");
  });
});

/* ========================================================================== */
describe("assignment", () => {
  test("round robin rotates across managers", () => {
    updateConfig(ORG, { assignment: { sales: "ROUND_ROBIN", loan: "LEAST_LOADED" } });
    const picked: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { customer } = upsertCustomer({ orgId: ORG, phone: `+91 9111 100${i}`, name: `RR ${i}` });
      const r = assign({ orgId: ORG, customerId: customer.id, queue: "SALES", reason: "test" });
      picked.push(r.assignee!.id);
    }
    assert.equal(new Set(picked).size, Math.min(salesManagers().length, 4));
  });

  test("least loaded prefers the manager with fewest open leads", () => {
    updateConfig(ORG, { assignment: { sales: "LEAST_LOADED", loan: "LEAST_LOADED" } });
    const load = workload(ORG, "SALES");
    // Same tie-break as pick(): lowest load, then stable by id.
    const lightest = [...load.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0][0];
    const { customer } = upsertCustomer({ orgId: ORG, phone: "+91 9111 2000", name: "LL" });
    const r = assign({ orgId: ORG, customerId: customer.id, queue: "SALES", reason: "test" });
    assert.equal(r.assignee!.id, lightest);
  });

  test("records an assignment even when nobody is available", () => {
    const { customer } = upsertCustomer({ orgId: ORG, phone: "+91 9111 3000", name: "NoTeam" });
    const r = assign({ orgId: "org-with-no-team", customerId: customer.id, queue: "SALES", reason: "test" });
    assert.equal(r.assignee, undefined);
    assert.match(r.assignment.reason, /no eligible/);
  });
});

/* ========================================================================== */
describe("authorization model", () => {
  const { MAP_FOR_TEST } = require("../src/lib/auth/permissions-test-view") as {
    MAP_FOR_TEST: Record<string, string>;
  };

  test("every legacy permission name maps to a real database permission", () => {
    const { PERMISSIONS } = require("../src/lib/auth/session") as typeof import("../src/lib/auth/session");
    const real = new Set<string>(PERMISSIONS);
    for (const [legacy, mapped] of Object.entries(MAP_FOR_TEST)) {
      assert.ok(real.has(mapped), `${legacy} maps to ${mapped}, which is not a granted permission`);
    }
  });

  test("document permissions are distinct from customer permissions", () => {
    // The department boundary: reading a customer must never imply reading
    // their bank statements.
    assert.notEqual(MAP_FOR_TEST["customer:read"], MAP_FOR_TEST["document:read"]);
    assert.equal(MAP_FOR_TEST["document:review"], "documents.verify");
  });

  test("rate limiting locks out after repeated attempts and resets on success", () => {
    const key = `test:${Math.random()}`;
    for (let i = 0; i < 8; i++) assert.equal(rateLimit(key, { max: 8, windowSeconds: 60 }).allowed, true);
    const blocked = rateLimit(key, { max: 8, windowSeconds: 60 });
    assert.equal(blocked.allowed, false);
    resetLimit(key);
    assert.equal(rateLimit(key, { max: 8, windowSeconds: 60 }).allowed, true);
  });
});

/* ========================================================================== */
describe("document storage security", () => {
  test("signed refs are bound to the member and expire", () => {
    const t = signDocumentRef("doc_1", "mem_1", 60);
    assert.equal(verifyDocumentRef("doc_1", "mem_1", t), true);
    assert.equal(verifyDocumentRef("doc_1", "mem_2", t), false, "a leaked link must not work for someone else");
    assert.equal(verifyDocumentRef("doc_2", "mem_1", t), false);
    assert.equal(verifyDocumentRef("doc_1", "mem_1", signDocumentRef("doc_1", "mem_1", -1)), false);
  });

  test("rejects unsupported types, oversized and empty files", () => {
    assert.ok(validateUpload("application/x-msdownload", 100));
    assert.ok(validateUpload("application/pdf", 999_999_999));
    assert.ok(validateUpload("application/pdf", 0));
    assert.equal(validateUpload("application/pdf", 1000), null);
    assert.ok(validateUpload("image/png", 1000, ["pdf"]), "must honour per-item accepted formats");
  });

  test("path traversal is rejected", async () => {
    const { LocalDocumentStore } = require("../src/lib/ops/storage") as typeof import("../src/lib/ops/storage");
    const store = new LocalDocumentStore();
    await assert.rejects(() => store.put("../../escape.txt", Buffer.from("x")));
  });
});

/* ========================================================================== */
describe("follow-up guards", () => {
  test("quiet hours push a send forward", () => {
    const cfg = getConfig(ORG);
    updateConfig(ORG, { messaging: { ...cfg.messaging, quietHoursStart: 21, quietHoursEnd: 9, timezone: "UTC" } });
    const at2am = new Date("2026-01-01T02:00:00Z").toISOString();
    const moved = nextSendableTime(at2am, getConfig(ORG));
    assert.ok(new Date(moved).getUTCHours() >= 9, `expected >= 09:00 UTC, got ${moved}`);
    const at2pm = new Date("2026-01-01T14:00:00Z").toISOString();
    assert.equal(nextSendableTime(at2pm, getConfig(ORG)), at2pm, "daytime must not be shifted");
  });

  test("human control pauses the lane and releasing resumes it", () => {
    const { customer } = upsertCustomer({ orgId: ORG, phone: "+91 9222 1000", name: "Takeover" });
    createFollowUp({ orgId: ORG, customerId: customer.id, kind: "SALES_NUDGE", lane: "SALES", reason: "test", scheduledAt: new Date(0).toISOString() });
    setControl(customer.id, "SALES", "HUMAN_CONTROL", { type: "human" });
    assert.ok(read().followUps.filter((f) => f.customerId === customer.id).every((f) => f.status === "PAUSED"));
    setControl(customer.id, "SALES", "AI_ACTIVE", { type: "human" });
    assert.ok(read().followUps.filter((f) => f.customerId === customer.id).every((f) => f.status === "SCHEDULED"));
  });

  test("opt-out stops automation entirely", () => {
    const { customer } = upsertCustomer({ orgId: ORG, phone: "+91 9222 2000", name: "OptOut" });
    createFollowUp({ orgId: ORG, customerId: customer.id, kind: "SALES_NUDGE", lane: "SALES", reason: "test", scheduledAt: new Date(0).toISOString() });
    updateCustomer(customer.id, { optedOut: true }, { type: "human" });
    const due = dueFollowUps(ORG);
    assert.ok(due.skipped.some((s) => /opted out/i.test(s.reason)));
    assert.ok(!due.due.some((d) => d.followUp.customerId === customer.id));
  });

  test("duplicate follow-ups for the same item are not created", () => {
    const { customer } = upsertCustomer({ orgId: ORG, phone: "+91 9222 3000", name: "Dupe" });
    const a = createFollowUp({ orgId: ORG, customerId: customer.id, kind: "DOCUMENT_REQUEST", lane: "LOAN", reason: "x" });
    const b = createFollowUp({ orgId: ORG, customerId: customer.id, kind: "DOCUMENT_REQUEST", lane: "LOAN", reason: "x" });
    assert.equal(a!.id, b!.id);
  });

  test("escalations are deduplicated per rule", () => {
    const { customer } = upsertCustomer({ orgId: ORG, phone: "+91 9222 4000", name: "Esc" });
    const a = escalate({ orgId: ORG, customerId: customer.id, ruleId: "requested_human", lane: "SALES", severity: "HIGH", reason: "r", detail: "d" });
    const b = escalate({ orgId: ORG, customerId: customer.id, ruleId: "requested_human", lane: "SALES", severity: "HIGH", reason: "r", detail: "d" });
    assert.equal(a!.id, b!.id);
  });
});

/* ========================================================================== */
describe("documents", () => {
  test("acceptance is only reachable through human review, and rejection needs a reason", async () => {
    const { customer } = upsertCustomer({ orgId: ORG, phone: "+91 9333 1000", name: "Doc Test" });
    const { loanCase } = createLoanCase({ orgId: ORG, customerId: customer.id });
    applyChecklistTemplate(loanCase.id, "standard_home_loan", { type: "human" });
    const item = checklistFor(loanCase.id)[0];

    const stored = await receiveDocument({
      orgId: ORG, customerId: customer.id, filename: "id.pdf", mimeType: "application/pdf",
      data: samplePdf("id"), checklistItemId: item.id, loanCaseId: loanCase.id, uploadedBy: "customer",
    });
    assert.ok(stored.ok);
    assert.equal(checklistFor(loanCase.id)[0].status, "UPLOADED", "receiving must never imply acceptance");

    const officer = loanOfficers()[0];
    const bad = reviewDocument(stored.ok ? stored.document.id : "", "REJECTED", { id: officer.id, type: "human" });
    assert.equal(bad.ok, false, "a rejection without a reason is unactionable");

    const good = reviewDocument(stored.ok ? stored.document.id : "", "ACCEPTED", { id: officer.id, type: "human" });
    assert.ok(good.ok);
    assert.equal(checklistFor(loanCase.id)[0].status, "ACCEPTED");
  });

  test("identical resubmissions are deduplicated", async () => {
    const { customer } = upsertCustomer({ orgId: ORG, phone: "+91 9333 2000", name: "Dedupe" });
    const { loanCase } = createLoanCase({ orgId: ORG, customerId: customer.id });
    applyChecklistTemplate(loanCase.id, "standard_home_loan", { type: "human" });
    const item = checklistFor(loanCase.id)[0];
    const payload = samplePdf("same");
    const a = await receiveDocument({ orgId: ORG, customerId: customer.id, filename: "a.pdf", mimeType: "application/pdf", data: payload, checklistItemId: item.id, uploadedBy: "customer" });
    const b = await receiveDocument({ orgId: ORG, customerId: customer.id, filename: "b.pdf", mimeType: "application/pdf", data: payload, checklistItemId: item.id, uploadedBy: "customer" });
    assert.ok(a.ok && b.ok);
    assert.equal(b.ok && b.duplicate, true);
    assert.equal(read().documents.filter((d) => d.customerId === customer.id).length, 1);
  });

  test("a failed store does not create a document row", async () => {
    const { setDocumentStore, documentStore } = require("../src/lib/ops/storage") as typeof import("../src/lib/ops/storage");
    const original = documentStore();
    setDocumentStore({
      put: async () => { throw new Error("disk full"); },
      get: async () => null, delete: async () => {}, exists: async () => false,
    });
    const { customer } = upsertCustomer({ orgId: ORG, phone: "+91 9333 3000", name: "Fail" });
    const before = read().documents.length;
    const res = await receiveDocument({ orgId: ORG, customerId: customer.id, filename: "x.pdf", mimeType: "application/pdf", data: samplePdf("f"), uploadedBy: "customer" });
    assert.equal(res.ok, false);
    assert.equal(read().documents.length, before, "never record a document we did not store");
    setDocumentStore(original);
  });
});

/* ========================================================================== */
describe("AI tool contract", () => {
  test("tools return ok:false rather than throwing or fabricating", () => {
    const { customer } = upsertCustomer({ orgId: ORG, phone: "+91 9444 1000", name: "Tools" });
    const ctx = { orgId: ORG, customerId: customer.id, actorType: "ai" as const };
    const noCase = TOOLS.get_loan_case(ctx);
    assert.equal(noCase.ok, false, "no case must be reported, not invented");
    const missing = TOOLS.get_document_checklist(ctx);
    assert.equal(missing.ok, false);
    const profile = TOOLS.get_customer_profile(ctx);
    assert.equal(profile.ok, true);
  });

  test("record_document_received refuses when no file was actually stored", () => {
    const { customer } = upsertCustomer({ orgId: ORG, phone: "+91 9444 2000", name: "NoFile" });
    const { loanCase } = createLoanCase({ orgId: ORG, customerId: customer.id });
    applyChecklistTemplate(loanCase.id, "standard_home_loan", { type: "human" });
    const item = checklistFor(loanCase.id)[0];
    const res = TOOLS.record_document_received(
      { orgId: ORG, customerId: customer.id, actorType: "ai" },
      { checklistItemId: item.id },
    );
    assert.equal(res.ok, false, "the assistant must not claim receipt of a file that does not exist");
  });

  test("the assistant has no tool to invent a document requirement", () => {
    const names = Object.keys(TOOLS);
    assert.ok(!names.some((n) => /add_checklist|create_checklist|add_document_requirement/.test(n)));
    assert.ok(!names.some((n) => /approve|accept_document|set_loan_status/.test(n)));
  });
});

/* ========================================================================== */
describe("completion and case status", () => {
  test("completion counts required items only and flips to READY_FOR_ANALYSIS at 100%", async () => {
    const { customer } = upsertCustomer({ orgId: ORG, phone: "+91 9555 1000", name: "Progress" });
    const { loanCase } = createLoanCase({ orgId: ORG, customerId: customer.id });
    applyChecklistTemplate(loanCase.id, "standard_home_loan", { type: "human" });
    const officer = loanOfficers()[0];
    const items = checklistFor(loanCase.id);
    const required = items.filter((i) => i.required);
    const optional = items.filter((i) => !i.required);
    assert.ok(optional.length > 0, "fixture must include an optional item");

    for (const [n, item] of required.entries()) {
      const doc = await receiveDocument({
        orgId: ORG, customerId: customer.id, filename: `${item.documentType}.pdf`, mimeType: "application/pdf",
        data: samplePdf(item.documentType), checklistItemId: item.id, loanCaseId: loanCase.id, uploadedBy: "customer",
      });
      assert.ok(doc.ok);
      reviewDocument(doc.ok ? doc.document.id : "", "ACCEPTED", { id: officer.id, type: "human" });
      const p = caseProgress(loanCase.id);
      assert.equal(p.requiredAccepted, n + 1);
      assert.equal(p.completionPct, Math.round(((n + 1) / required.length) * 100));
    }

    assert.equal(caseProgress(loanCase.id).completionPct, 100);
    assert.equal(getCase(loanCase.id)!.status, "READY_FOR_ANALYSIS");
    assert.ok(getCase(loanCase.id)!.readyForReviewAt, "the moment of completion must be recorded");
    assert.equal(getCustomer(customer.id)!.leadStage, "READY_FOR_ANALYSIS");
  });

  test("a rejection moves the case back and schedules a replacement chase", async () => {
    const { customer } = upsertCustomer({ orgId: ORG, phone: "+91 9555 2000", name: "Reject" });
    const { loanCase } = createLoanCase({ orgId: ORG, customerId: customer.id });
    applyChecklistTemplate(loanCase.id, "standard_home_loan", { type: "human" });
    const officer = loanOfficers()[0];
    const item = checklistFor(loanCase.id)[0];
    // A customer who just uploaded has messaged us, so the 24h window is open.
    await handleInbound({ orgId: ORG, phone: customer.phone, body: "Sending my ID now", externalId: "wamid.REJ1" });
    const doc = await receiveDocument({
      orgId: ORG, customerId: customer.id, filename: "blurry.pdf", mimeType: "application/pdf",
      data: samplePdf("blurry"), checklistItemId: item.id, loanCaseId: loanCase.id, uploadedBy: "customer",
    });
    reviewDocument(doc.ok ? doc.document.id : "", "REJECTED", { id: officer.id, type: "human" }, "Not readable");
    assert.equal(checklistFor(loanCase.id)[0].status, "REJECTED");
    await notifyDocumentDecision(loanCase.id, item.id);
    const chase = read().followUps.filter((f) => f.customerId === customer.id && f.kind === "DOCUMENT_REJECTED");
    assert.ok(chase.length >= 1, "a rejection must produce a replacement request");
    const outbound = read().opsMessages.filter((m) => m.customerId === customer.id && m.direction === "outbound");
    assert.ok(outbound.some((m) => /Not readable/.test(m.body)), "the customer must be told why");
    assert.ok(!outbound.some((m) => /approved/i.test(m.body)), "the assistant must never mention approval");
  });
});

/* ========================================================================== */
describe("webhook idempotency", () => {
  test("the same platform message id is processed exactly once", async () => {
    const first = await handleInbound({ orgId: ORG, phone: "+91 9666 1000", name: "Idem", body: "Hello, what is the price?", externalId: "wamid.IDEM1" });
    const second = await handleInbound({ orgId: ORG, phone: "+91 9666 1000", name: "Idem", body: "Hello, what is the price?", externalId: "wamid.IDEM1" });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(read().opsMessages.filter((m) => m.externalId === "wamid.IDEM1").length, 1);
  });

  test("STOP opts the customer out and cancels automation", async () => {
    const out = await handleInbound({ orgId: ORG, phone: "+91 9666 2000", name: "Stopper", body: "STOP", externalId: "wamid.STOP1" });
    assert.equal(getCustomer(out.customerId)!.optedOut, true);
  });
});

/* ========================================================================== */
describe("reply quality", () => {
  test("never sends the same sentence twice in a row", async () => {
    const phone = "+91 9777 1000";
    await handleInbound({ orgId: ORG, phone, name: "Repeat Test", body: "hello", externalId: "wamid.R1" });
    await handleInbound({ orgId: ORG, phone, body: "hello", externalId: "wamid.R2" });
    await handleInbound({ orgId: ORG, phone, body: "hello", externalId: "wamid.R3" });
    const customer = read().customers.find((c) => c.phone === phone)!;
    const out = read()
      .opsMessages.filter((m) => m.customerId === customer.id && m.direction === "outbound")
      .map((m) => m.body);
    for (let i = 1; i < out.length; i++) {
      assert.notEqual(out[i], out[i - 1], "consecutive identical replies read as a broken bot");
    }
  });

  test("answers the message in front of it, not the accumulated intent", async () => {
    const phone = "+91 9777 2000";
    const expectations: Array<[string, RegExp]> = [
      ["What does a 3 bedroom cost?", /pricing|price/i],
      ["And is anything available in March?", /available/i],
      ["Could I see it in person?", /viewing|days.*suit/i],
    ];
    for (const [i, [body]] of expectations.entries()) {
      await handleInbound({ orgId: ORG, phone, name: "Intent Test", body, externalId: `wamid.I${i}` });
    }
    const customer = read().customers.find((c) => c.phone === phone)!;
    const out = read()
      .opsMessages.filter((m) => m.customerId === customer.id && m.direction === "outbound")
      .map((m) => m.body);
    assert.equal(out.length, expectations.length);
    expectations.forEach(([body, pattern], i) => {
      assert.match(out[i], pattern, `reply to "${body}" was "${out[i]}"`);
    });
  });
});

/* ========================================================================== */
describe("END-TO-END ACCEPTANCE (§38)", () => {
  test("customer → AI → sales → loan → documents → ready for review", async () => {
    const phone = "+91 98765 43210";

    // 1–4. Customer contacts WhatsApp; AI qualifies, tracks intent and sentiment.
    await handleInbound({ orgId: ORG, phone, name: "Acceptance Customer", body: "Hi, I saw your listing. What is the price for a 3 bedroom?", externalId: "wamid.E2E1" });
    const step2 = await handleInbound({ orgId: ORG, phone, body: "Looks great. Can I book a site visit this week? My budget is around 5 Cr", externalId: "wamid.E2E2" });
    const customerId = step2.customerId;
    let customer = getCustomer(customerId)!;
    assert.ok(["HIGH_INTENT", "INTERESTED", "READY_TO_PROCEED"].includes(customer.intent), `intent was ${customer.intent}`);
    assert.ok(read().sentimentEvents.some((s) => s.customerId === customerId));
    assert.ok(customer.leadScore > 0, "scoring must have run");

    // 5–6. High intent → sales task created and a manager assigned.
    const step3 = await handleInbound({ orgId: ORG, phone, body: "Please have someone call me today", externalId: "wamid.E2E3" });
    assert.ok(step3.salesTaskId, "a sales task must be created");
    customer = getCustomer(customerId)!;
    assert.ok(customer.assignedSalesManagerId, "a sales manager must be assigned");
    const manager = members().find((m) => m.id === customer.assignedSalesManagerId)!;

    // 7. The manager gets a briefing without reading the transcript.
    const { buildBriefing } = require("../src/lib/ops/sales") as typeof import("../src/lib/ops/sales");
    const briefing = buildBriefing(customerId);
    assert.match(briefing.text, /CUSTOMER SUMMARY/);
    assert.ok(briefing.recommendedAction.length > 0);

    // 8–9. Manager calls, then marks financing required.
    const { updateSalesTask } = require("../src/lib/ops/sales") as typeof import("../src/lib/ops/sales");
    updateSalesTask(step3.salesTaskId!, { status: "COMPLETED", note: "Spoke to customer; needs a loan" }, { id: manager.id, type: "human" });

    // 10–11. Loan case created and an officer assigned.
    const { loanCase, created } = createLoanCase({ orgId: ORG, customerId, loanType: "home", requestedAmount: 40_000_000, actorId: manager.id, actorType: "human" });
    assert.equal(created, true);
    assert.equal(getCustomer(customerId)!.loanRequired, "YES");
    const officerId = getCustomer(customerId)!.assignedLoanOfficerId;
    assert.ok(officerId, "a loan officer must be assigned");
    // Creating twice must not open a second case.
    assert.equal(createLoanCase({ orgId: ORG, customerId }).created, false);

    // 12. Officer configures the required documents.
    const officer = members().find((m) => m.id === officerId)!;
    applyChecklistTemplate(loanCase.id, "standard_home_loan", { id: officer.id, type: "human" });
    const items = checklistFor(loanCase.id);
    assert.ok(items.length >= 6);

    // 13. Customer receives a document request over WhatsApp.
    for (const i of items) updateChecklistItem(i.id, { status: "REQUESTED" }, { id: officer.id, type: "human" });
    // Disable quiet hours BEFORE scheduling. Scheduling applies the quiet-hours
    // window at creation time, so doing this afterwards left the follow-up
    // parked until 09:00 and made the test pass or fail depending on what time
    // of day it happened to run.
    updateConfig(ORG, { messaging: { ...getConfig(ORG).messaging, quietHoursStart: 0, quietHoursEnd: 0, maxAutomatedPerDay: 50 } });
    const { syncDocumentFollowUps } = require("../src/lib/ops/followups") as typeof import("../src/lib/ops/followups");
    syncDocumentFollowUps(loanCase.id);
    const tick = await runFollowUpTick(ORG);
    assert.ok(tick.sent >= 1, `expected at least one follow-up sent, got ${JSON.stringify(tick)}`);
    const requested = read().opsMessages.filter((m) => m.customerId === customerId && m.direction === "outbound");
    assert.ok(requested.some((m) => /aadhaar card|aadhaar|pan card|photo id|income|salary|address/i.test(m.body)), "the request must name a real checklist item");

    // 14–15. Customer uploads; it appears for the officer as UPLOADED, not accepted.
    const first = items[0];
    const upload = await receiveDocument({
      orgId: ORG, customerId, filename: "photo-id.pdf", mimeType: "application/pdf",
      data: samplePdf("e2e-id"), checklistItemId: first.id, loanCaseId: loanCase.id, uploadedBy: "customer",
    });
    assert.ok(upload.ok);
    assert.equal(checklistFor(loanCase.id).find((i) => i.id === first.id)!.status, "UPLOADED");

    // 16–17. Officer rejects; the AI tells the customer why and asks again.
    reviewDocument(upload.ok ? upload.document.id : "", "REJECTED", { id: officer.id, type: "human" }, "The photo is cut off at the edges");
    await notifyDocumentDecision(loanCase.id, first.id);
    const afterReject = read().opsMessages.filter((m) => m.customerId === customerId && m.direction === "outbound");
    assert.ok(afterReject.some((m) => /cut off at the edges/.test(m.body)), "the officer's reason must reach the customer");

    // Replacement accepted.
    const replacement = await receiveDocument({
      orgId: ORG, customerId, filename: "photo-id-2.pdf", mimeType: "application/pdf",
      data: samplePdf("e2e-id-fixed"), checklistItemId: first.id, loanCaseId: loanCase.id, uploadedBy: "customer",
    });
    reviewDocument(replacement.ok ? replacement.document.id : "", "ACCEPTED", { id: officer.id, type: "human" });
    assert.equal(checklistFor(loanCase.id).find((i) => i.id === first.id)!.status, "ACCEPTED");

    // 18–19. Remaining required documents completed.
    for (const item of checklistFor(loanCase.id).filter((i) => i.required && i.status !== "ACCEPTED")) {
      const d = await receiveDocument({
        orgId: ORG, customerId, filename: `${item.documentType}.pdf`, mimeType: "application/pdf",
        data: samplePdf(`e2e-${item.documentType}`), checklistItemId: item.id, loanCaseId: loanCase.id, uploadedBy: "customer",
      });
      reviewDocument(d.ok ? d.document.id : "", "ACCEPTED", { id: officer.id, type: "human" });
    }

    // 20–21. Officer notified; case is ready.
    const progress = caseProgress(loanCase.id);
    assert.equal(progress.completionPct, 100);
    assert.equal(getCase(loanCase.id)!.status, "READY_FOR_ANALYSIS");
    assert.ok(
      read().opsNotifications.some((n) => n.customerId === customerId && n.event === "loan_case.ready_for_analysis"),
      "the officer must be notified",
    );

    // 22. Admin sees the full timeline.
    const timeline = read().auditEvents.filter((a) => a.customerId === customerId);
    for (const action of ["customer.created", "sales_task.created", "sales.assigned", "loan_case.created", "loan.assigned", "checklist.items_added", "document.received", "document.rejected", "document.accepted", "loan_case.status_changed"]) {
      assert.ok(timeline.some((t) => t.action === action), `audit trail is missing ${action}`);
    }
    assert.deepEqual([...timeline].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((t) => t.id), timeline.map((t) => t.id), "audit must be chronological");

    // 23–24. Sales sees the stage; the officer sees every document.
    assert.equal(getCustomer(customerId)!.leadStage, "READY_FOR_ANALYSIS");
    assert.equal(read().documents.filter((d) => d.loanCaseId === loanCase.id).length, checklistFor(loanCase.id).filter((i) => i.required).length + 1);

    // 25. The AI stayed inside its scope throughout.
    const allOutbound = read().opsMessages.filter((m) => m.customerId === customerId && m.authorType === "ai");
    assert.ok(!allOutbound.some((m) => /\bapproved\b|\beligible\b|\bsanction/i.test(m.body)), "the assistant must never speak to approval");
  });
});
