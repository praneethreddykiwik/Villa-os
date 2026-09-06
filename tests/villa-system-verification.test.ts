import assert from "node:assert/strict";
import test, { describe, before, after } from "node:test";
import { isolate, cleanup, samplePdf, seedTeam } from "./helpers";

const dir = isolate("villa-system");
after(() => cleanup(dir));

const { read, mutate, resetToBootstrap } = require("../src/lib/db") as typeof import("../src/lib/db");
const { ensureOpsSeed, defaultOrgId } = require("../src/lib/ops/seed") as typeof import("../src/lib/ops/seed");
const { upsertCustomer, getCustomer } = require("../src/lib/ops/customers") as typeof import("../src/lib/ops/customers");
const { handleInbound } = require("../src/lib/ops/agent") as typeof import("../src/lib/ops/agent");
const { activeCase, caseProgress, checklistFor } = require("../src/lib/ops/loan") as typeof import("../src/lib/ops/loan");
const { reviewDocument } = require("../src/lib/ops/documents") as typeof import("../src/lib/ops/documents");
const { book, slots } = require("../src/lib/appointments/engine") as typeof import("../src/lib/appointments/engine");
const { requiredPermissionFor } = require("../src/lib/auth/page-access") as typeof import("../src/lib/auth/page-access");

let ORG = "";
before(() => {
  resetToBootstrap();
  ORG = defaultOrgId();
  ensureOpsSeed(ORG);
  seedTeam(ORG);
});

describe("1. Navigation & Route Permission Matrix", () => {
  const routes: Array<{ path: string; group: string; expectedPerm: string | "allow" }> = [
    // Overview
    { path: "/dashboard", group: "Overview", expectedPerm: "analytics.view" },
    { path: "/insights", group: "Overview", expectedPerm: "analytics.view" },
    { path: "/analytics", group: "Overview", expectedPerm: "analytics.view" },

    // Channels
    { path: "/channels/instagram", group: "Channels", expectedPerm: "marketing.read" },
    { path: "/channels/facebook", group: "Channels", expectedPerm: "marketing.read" },
    { path: "/channels/linkedin", group: "Channels", expectedPerm: "marketing.read" },
    { path: "/channels/youtube", group: "Channels", expectedPerm: "marketing.read" },

    // Create & publish
    { path: "/composer", group: "Create & publish", expectedPerm: "marketing.read" },
    { path: "/automation", group: "Create & publish", expectedPerm: "marketing.read" },
    { path: "/publish-v2", group: "Create & publish", expectedPerm: "marketing.read" },
    { path: "/studio", group: "Create & publish", expectedPerm: "marketing.read" },
    { path: "/board", group: "Create & publish", expectedPerm: "marketing.read" },
    { path: "/calendar", group: "Create & publish", expectedPerm: "marketing.read" },
    { path: "/ideas", group: "Create & publish", expectedPerm: "marketing.read" },

    // CRM
    { path: "/crm/leads", group: "CRM", expectedPerm: "sales.read" },
    { path: "/crm/pipeline", group: "CRM", expectedPerm: "sales.read" },
    { path: "/crm/contacts", group: "CRM", expectedPerm: "customers.read" },
    { path: "/crm/customers", group: "CRM", expectedPerm: "sales.read" },
    { path: "/crm/appointments", group: "CRM", expectedPerm: "sales.read" },
    { path: "/crm/tasks", group: "CRM", expectedPerm: "sales.read" },
    { path: "/crm/follow-ups", group: "CRM", expectedPerm: "sales.read" },

    // Engage
    { path: "/voice", group: "Engage", expectedPerm: "customers.read" },
    { path: "/voice/whatsapp-training", group: "Engage", expectedPerm: "customers.read" },
    { path: "/inbox/whatsapp", group: "Engage", expectedPerm: "customers.read" },

    // Grow
    { path: "/ads", group: "Grow", expectedPerm: "analytics.view" },
    { path: "/engagement", group: "Grow", expectedPerm: "customers.read" },
    { path: "/reviews", group: "Grow", expectedPerm: "customers.read" },
    { path: "/local", group: "Grow", expectedPerm: "marketing.read" },

    // Operations
    { path: "/ops", group: "Operations", expectedPerm: "allow" },
    { path: "/ops/messages", group: "Operations", expectedPerm: "customers.read" },
    { path: "/ops/sales", group: "Operations", expectedPerm: "sales.read" },
    { path: "/ops/loans", group: "Operations", expectedPerm: "loans.read" },
    { path: "/ops/admin", group: "Operations", expectedPerm: "analytics.view" },

    // System
    { path: "/reports", group: "System", expectedPerm: "analytics.view" },
    { path: "/activity", group: "System", expectedPerm: "analytics.view" },
    { path: "/connections", group: "System", expectedPerm: "workflows.manage" },
    { path: "/settings", group: "System", expectedPerm: "workflows.manage" },
  ];

  test("every route in the sidebar has a defined permission check", () => {
    for (const r of routes) {
      const perm = requiredPermissionFor(r.path);
      assert.equal(
        perm,
        r.expectedPerm,
        `Route ${r.path} (${r.group}) expected permission ${r.expectedPerm}, got ${perm}`
      );
    }
  });

  test("role capabilities map properly to navigation access", () => {
    const adminPerms = new Set(["analytics.view", "sales.read", "sales.write", "loans.read", "loans.write", "marketing.read", "customers.read", "workflows.manage", "users.manage"]);
    const loanPerms = new Set(["loans.read", "loans.write", "documents.read", "documents.verify", "customers.read"]);
    const salesPerms = new Set(["sales.read", "sales.write", "customers.read", "customers.write"]);
    const marketingPerms = new Set(["marketing.read", "marketing.publish", "analytics.view"]);

    // Loan officer can access loan cases and WhatsApp inbox, but NOT settings/connections or sales pipeline
    assert.equal(loanPerms.has(requiredPermissionFor("/ops/loans") as any), true);
    assert.equal(loanPerms.has(requiredPermissionFor("/inbox/whatsapp") as any), true);
    assert.equal(loanPerms.has(requiredPermissionFor("/settings") as any), false);
    assert.equal(loanPerms.has(requiredPermissionFor("/crm/pipeline") as any), false);

    // Sales manager can access leads, pipeline, appointments, and sales queue
    assert.equal(salesPerms.has(requiredPermissionFor("/crm/leads") as any), true);
    assert.equal(salesPerms.has(requiredPermissionFor("/crm/pipeline") as any), true);
    assert.equal(salesPerms.has(requiredPermissionFor("/ops/sales") as any), true);
    assert.equal(salesPerms.has(requiredPermissionFor("/ops/loans") as any), false);

    // Marketing lead can access channels, composer, studio, and publish
    assert.equal(marketingPerms.has(requiredPermissionFor("/channels/instagram") as any), true);
    assert.equal(marketingPerms.has(requiredPermissionFor("/channels/youtube") as any), true);
    assert.equal(marketingPerms.has(requiredPermissionFor("/automation") as any), true);
    assert.equal(marketingPerms.has(requiredPermissionFor("/ops/loans") as any), false);

    // Admin has access to everything
    for (const r of routes) {
      if (r.expectedPerm === "allow") continue;
      assert.equal(adminPerms.has(r.expectedPerm as any), true, `Admin should have access to ${r.path}`);
    }
  });
});

describe("2. Villa Management End-to-End Workflow & Database Persistence", () => {
  const testPhone = "+91 98888 77777";
  const testName = "Arjun Sharma (Villa 402 Lead)";
  let customerId = "";
  let loanCaseId = "";
  let appointmentId = "";

  test("Step 1: Ingest villa lead into CRM database", () => {
    const { customer, created } = upsertCustomer({
      orgId: ORG,
      phone: testPhone,
      name: testName,
      source: "whatsapp",
    });

    assert.equal(created, true);
    customerId = customer.id;
    assert.ok(customerId);

    const stored = getCustomer(customerId);
    assert.equal(stored?.name, testName);
    assert.equal(stored?.phone, testPhone);
  });

  test("Step 2: Book villa site visit appointment in database", () => {
    const db = read();
    const brand = db.brands[0];
    const availableSlots = slots(brand.id, new Date().toISOString(), 7);
    assert.ok(availableSlots.length > 0, "Slots should be available");
    const chosenSlot = availableSlots[0].startsAt;

    const res = book({
      brandId: brand.id,
      startsAt: chosenSlot,
      customerName: testName,
      customerPhone: testPhone,
      channel: "whatsapp",
      createdBy: "sales",
      notes: "Client interested in 4BHK East-facing Villa 402",
    });

    assert.equal(res.ok, true);
    assert.ok(res.appointment);
    appointmentId = res.appointment!.id;

    const dbNow = read();
    const exists = (dbNow.appointments ?? []).some((a: any) => a.id === appointmentId);
    assert.equal(exists, true);
  });

  test("Step 3: Customer requests villa home loan via WhatsApp — auto-opens case with 5 required documents", async () => {
    const out = await handleInbound({
      orgId: ORG,
      phone: testPhone,
      name: testName,
      body: "I want to apply for a home loan for Villa 402. What documents are required?",
      externalId: "wamid.VILLA_LOAN_1",
    });

    const lCase = activeCase(customerId);
    assert.ok(lCase, "Loan case should be active");
    loanCaseId = lCase!.id;

    // Check checklist items
    const items = checklistFor(loanCaseId);
    const requiredItems = items.filter((i) => i.required);
    assert.ok(requiredItems.length >= 5, "Checklist should contain at least 5 required documents");

    // Reply must list the documents
    assert.ok(out.reply, "Agent should reply to loan request");
    assert.match(out.reply!, /Aadhaar|PAN|Bank/i);
  });

  test("Step 4: Customer submits documents via WhatsApp, agent acknowledges and tracks remaining items", async () => {
    const items = checklistFor(loanCaseId).filter((i) => i.required);

    // Upload first document (Aadhaar)
    const doc1 = await handleInbound({
      orgId: ORG,
      phone: testPhone,
      body: "[Aadhaar card upload]",
      externalId: "wamid.DOC_1",
      type: "document",
      media: {
        filename: "aadhaar_card.pdf",
        mimeType: "application/pdf",
        data: samplePdf("aadhaar"),
      },
    });

    assert.ok(doc1.reply);
    assert.match(doc1.reply!, /received your Aadhaar card|Still needed/i);

    // Upload remaining required documents
    for (let idx = 1; idx < items.length; idx++) {
      const item = items[idx];
      const res = await handleInbound({
        orgId: ORG,
        phone: testPhone,
        body: `[${item.customerLabel} upload]`,
        externalId: `wamid.DOC_${idx + 1}`,
        type: "document",
        media: {
          filename: `${item.documentType}.pdf`,
          mimeType: "application/pdf",
          data: samplePdf(`doc-${idx}`),
        },
      });

      if (idx === items.length - 1) {
        // Last document: agent tells customer all documents are received and with the loan team
        assert.match(res.reply!, /All documents received|review/i);
      }
    }

    const progress = caseProgress(loanCaseId);
    assert.equal(progress.missing.length, 0, "No documents should be missing");
    assert.equal(progress.allReceived, true, "All required documents must be received");
  });

  test("Step 5: Loan Officer reviews documents, accepts them, case is ready for bank submission", () => {
    const items = checklistFor(loanCaseId).filter((i) => i.required);
    const db = read();
    const officer = db.teamMembers.find((m) => m.role === "LOAN_OFFICER") || { id: "mem_loan_test" };

    for (const item of items) {
      assert.ok(item.currentDocumentId);
      reviewDocument(item.currentDocumentId!, "ACCEPTED", { id: officer.id, type: "human" });
    }

    const updatedProgress = caseProgress(loanCaseId);
    assert.equal(updatedProgress.completionPct, 100);
    assert.equal(updatedProgress.requiredAccepted, updatedProgress.requiredTotal);

    const lCase = activeCase(customerId);
    assert.equal(lCase?.status, "READY_FOR_ANALYSIS");
  });

  test("Step 6: Database cleanup — deletes test records to leave no test clutter", () => {
    mutate((db) => {
      // Clean up appointments
      if (db.appointments) {
        db.appointments = db.appointments.filter((a) => a.id !== appointmentId);
      }
      // Clean up loan cases and checklist items
      db.loanCases = db.loanCases.filter((l) => l.id !== loanCaseId);
      db.checklistItems = db.checklistItems.filter((c) => c.loanCaseId !== loanCaseId);
      // Clean up documents
      db.documents = db.documents.filter((d) => d.customerId !== customerId);
      // Clean up ops messages
      db.opsMessages = db.opsMessages.filter((m) => m.customerId !== customerId);
      // Clean up customer
      db.customers = db.customers.filter((c) => c.id !== customerId);
    });

    // Verify deleted
    assert.equal(getCustomer(customerId), undefined, "Customer should be deleted");
    assert.equal(activeCase(customerId), undefined, "Loan case should be deleted");
    const dbAfter = read();
    assert.equal(dbAfter.appointments?.some((a) => a.id === appointmentId) ?? false, false);
  });
});
