import { mutate, read } from "../db";
import { uid } from "../ids";
import { assign } from "./assignment";
import { audit, notify } from "./audit";
import { getConfig, updateConfig } from "./config";
import { setStage, updateCustomer } from "./customers";
import type { ChecklistItem, ChecklistItemStatus, LoanCase, LoanStatus, WorkflowConfig } from "./types";

/**
 * LOAN WORKFLOW
 *
 * The checklist is owned by the loan department, never by the AI. The document
 * assistant reads it and nothing else — it cannot add a requirement, and it
 * cannot mark anything accepted. Those are the two failure modes that turn a
 * helpful assistant into a liability: inventing paperwork, and telling a
 * customer they are approved when nobody decided that.
 */

export function activeCase(customerId: string): LoanCase | undefined {
  return read().loanCases.find(
    (l) => l.customerId === customerId && !["COMPLETED", "REJECTED"].includes(l.status),
  );
}

export function getCase(loanCaseId: string): LoanCase | undefined {
  return read().loanCases.find((l) => l.id === loanCaseId);
}

/**
 * Create the loan case. Idempotent: a sales manager clicking "financing
 * required" twice must not open two cases against one customer.
 */
export function createLoanCase(opts: {
  orgId: string;
  customerId: string;
  loanType?: string;
  requestedAmount?: number;
  actorId?: string;
  actorType?: "human" | "ai" | "system";
  assigneeId?: string;
}): { loanCase: LoanCase; created: boolean } {
  const existing = activeCase(opts.customerId);
  if (existing) return { loanCase: existing, created: false };

  const now = new Date().toISOString();
  const loanCase: LoanCase = {
    id: uid("lcs"),
    orgId: opts.orgId,
    customerId: opts.customerId,
    status: "NOT_STARTED",
    loanType: opts.loanType ?? "standard",
    requestedAmount: opts.requestedAmount,
    officerNotes: [],
    createdAt: now,
    updatedAt: now,
  };

  mutate((db) => void db.loanCases.push(loanCase));
  updateCustomer(opts.customerId, { loanRequired: "YES" }, { id: opts.actorId, type: opts.actorType ?? "system" });
  setStage(opts.customerId, "LOAN_CASE", { id: opts.actorId, type: opts.actorType ?? "system" }, "Financing required");

  audit({
    orgId: opts.orgId,
    actorId: opts.actorId,
    actorType: opts.actorType ?? "system",
    action: "loan_case.created",
    entity: "loan_case",
    entityId: loanCase.id,
    customerId: opts.customerId,
    metadata: { loanType: loanCase.loanType, requestedAmount: opts.requestedAmount },
  });

  assign({
    orgId: opts.orgId,
    customerId: opts.customerId,
    queue: "LOAN",
    assigneeId: opts.assigneeId,
    reason: "Financing required",
    actorId: opts.actorId,
    actorType: opts.actorType ?? "system",
  });

  // A new case starts with the org's standard document set so the assistant
  // can ask for paperwork immediately; the officer edits from there.
  ensureDefaultChecklist(loanCase.id, { id: opts.actorId, type: opts.actorType === "human" ? "human" : "system" });

  return { loanCase: activeCase(opts.customerId) ?? loanCase, created: true };
}

/* -------------------------------------------------------------------------- */
/* Default document set                                                        */
/* -------------------------------------------------------------------------- */

export type ChecklistTemplateItem = WorkflowConfig["checklistTemplates"][number]["items"][number];

/** The org's default document set (the template a new case starts with). */
export function defaultChecklist(orgId: string): { templateId: string; items: ChecklistTemplateItem[] } {
  const cfg = getConfig(orgId);
  const template =
    cfg.checklistTemplates.find((t) => t.id === (cfg.defaultChecklistTemplateId ?? "standard_home_loan")) ??
    cfg.checklistTemplates[0];
  return { templateId: template?.id ?? "standard_home_loan", items: template?.items ?? [] };
}

/** Replace the org's default document set. Existing cases are untouched. */
export function setDefaultChecklist(orgId: string, items: ChecklistTemplateItem[]): ChecklistTemplateItem[] {
  const cfg = getConfig(orgId);
  const templateId = cfg.defaultChecklistTemplateId ?? "standard_home_loan";
  const clean = items
    .map((i) => ({
      documentType: (i.documentType || i.customerLabel).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      customerLabel: i.customerLabel.trim(),
      description: (i.description ?? "").trim(),
      required: Boolean(i.required),
      acceptedFormats: (i.acceptedFormats?.length ? i.acceptedFormats : ["jpg", "png", "pdf"]).map((f) => f.toLowerCase()),
    }))
    .filter((i, idx, all) => i.customerLabel && all.findIndex((x) => x.documentType === i.documentType) === idx);
  const templates = cfg.checklistTemplates.some((t) => t.id === templateId)
    ? cfg.checklistTemplates.map((t) => (t.id === templateId ? { ...t, items: clean } : t))
    : [{ id: templateId, name: "Standard home loan", items: clean }, ...cfg.checklistTemplates];
  updateConfig(orgId, { checklistTemplates: templates, defaultChecklistTemplateId: templateId });
  return clean;
}

/** Apply the default set once — only to a case that has no checklist at all. */
export function ensureDefaultChecklist(loanCaseId: string, actor: { id?: string; type: "human" | "system" }): ChecklistItem[] {
  const loanCase = getCase(loanCaseId);
  if (!loanCase) return [];
  if (checklistFor(loanCaseId).length) return [];
  const { items } = defaultChecklist(loanCase.orgId);
  if (!items.length) return [];
  return addChecklistItems(loanCaseId, items, actor);
}

export function setLoanStatus(
  loanCaseId: string,
  status: LoanStatus,
  actor: { id?: string; type: "human" | "ai" | "system" },
  note?: string,
): LoanCase | null {
  const before = getCase(loanCaseId);
  if (!before || before.status === status) return before ?? null;

  const updated = mutate((db) => {
    const l = db.loanCases.find((x) => x.id === loanCaseId);
    if (!l) return null;
    l.status = status;
    l.updatedAt = new Date().toISOString();
    if (note) l.officerNotes.push(note);
    if (["APPROVED", "REJECTED", "COMPLETED"].includes(status)) l.closedAt = l.updatedAt;
    return { ...l };
  });
  if (!updated) return null;

  audit({
    orgId: updated.orgId,
    actorId: actor.id,
    actorType: actor.type,
    action: "loan_case.status_changed",
    entity: "loan_case",
    entityId: loanCaseId,
    customerId: updated.customerId,
    metadata: { from: before.status, to: status, note },
  });

  const stageFor: Partial<Record<LoanStatus, Parameters<typeof setStage>[1]>> = {
    DOCUMENT_COLLECTION: "DOCUMENT_COLLECTION",
    UNDER_REVIEW: "DOCUMENT_REVIEW",
    DOCUMENTS_INCOMPLETE: "DOCUMENT_COLLECTION",
    READY_FOR_ANALYSIS: "READY_FOR_ANALYSIS",
    APPROVED: "DECISION",
    REJECTED: "DECISION",
    COMPLETED: "COMPLETED",
  };
  const stage = stageFor[status];
  if (stage) setStage(updated.customerId, stage, actor, `Loan status ${status}`);

  return updated;
}

/* -------------------------------------------------------------------------- */
/* Checklist                                                                   */
/* -------------------------------------------------------------------------- */

export function checklistFor(loanCaseId: string): ChecklistItem[] {
  return read()
    .checklistItems.filter((i) => i.loanCaseId === loanCaseId)
    .sort((a, b) => a.order - b.order);
}

export function addChecklistItems(
  loanCaseId: string,
  items: Array<Pick<ChecklistItem, "documentType" | "customerLabel" | "description" | "required" | "acceptedFormats"> & { dueAt?: string }>,
  actor: { id?: string; type: "human" | "system" },
): ChecklistItem[] {
  const loanCase = getCase(loanCaseId);
  if (!loanCase) return [];
  const existing = checklistFor(loanCaseId);
  const now = new Date().toISOString();
  let order = existing.length;

  const created: ChecklistItem[] = items
    // Adding the same document type twice is a mistake, not a requirement.
    .filter((i) => !existing.some((e) => e.documentType === i.documentType))
    .map((i) => ({
      id: uid("chk"),
      orgId: loanCase.orgId,
      loanCaseId,
      documentType: i.documentType,
      customerLabel: i.customerLabel,
      description: i.description,
      required: i.required,
      status: "NOT_REQUESTED" as ChecklistItemStatus,
      acceptedFormats: i.acceptedFormats,
      dueAt: i.dueAt,
      order: order++,
      createdAt: now,
      updatedAt: now,
    }));

  if (!created.length) return [];
  mutate((db) => void db.checklistItems.push(...created));

  audit({
    orgId: loanCase.orgId,
    actorId: actor.id,
    actorType: actor.type,
    action: "checklist.items_added",
    entity: "loan_case",
    entityId: loanCaseId,
    customerId: loanCase.customerId,
    metadata: { count: created.length, types: created.map((c) => c.documentType) },
  });

  if (loanCase.status === "NOT_STARTED" || loanCase.status === "INFORMATION_REQUIRED") {
    setLoanStatus(loanCaseId, "DOCUMENT_COLLECTION", actor, "Checklist created");
  }
  return created;
}

/** Apply a configured preset. The officer can then edit individual items. */
export function applyChecklistTemplate(
  loanCaseId: string,
  templateId: string,
  actor: { id?: string; type: "human" | "system" },
): ChecklistItem[] {
  const loanCase = getCase(loanCaseId);
  if (!loanCase) return [];
  const template = getConfig(loanCase.orgId).checklistTemplates.find((t) => t.id === templateId);
  if (!template) return [];
  return addChecklistItems(loanCaseId, template.items, actor);
}

export function updateChecklistItem(
  itemId: string,
  patch: Partial<Pick<ChecklistItem, "status" | "required" | "customerLabel" | "description" | "acceptedFormats" | "dueAt" | "notes" | "rejectionReason">>,
  actor: { id?: string; type: "human" | "ai" | "system" },
): ChecklistItem | null {
  const before = read().checklistItems.find((i) => i.id === itemId);
  if (!before) return null;

  const updated = mutate((db) => {
    const i = db.checklistItems.find((x) => x.id === itemId);
    if (!i) return null;
    Object.assign(i, patch, { updatedAt: new Date().toISOString() });
    return { ...i };
  });
  if (!updated) return null;

  audit({
    orgId: updated.orgId,
    actorId: actor.id,
    actorType: actor.type,
    action: "checklist.item_updated",
    entity: "checklist_item",
    entityId: itemId,
    customerId: getCase(updated.loanCaseId)?.customerId,
    metadata: { from: before.status, to: updated.status, patch },
  });

  refreshCaseProgress(updated.loanCaseId, actor);
  return updated;
}

export function removeChecklistItem(itemId: string, actor: { id?: string; type: "human" }): boolean {
  const item = read().checklistItems.find((i) => i.id === itemId);
  if (!item) return false;
  mutate((db) => void (db.checklistItems = db.checklistItems.filter((i) => i.id !== itemId)));
  audit({
    orgId: item.orgId,
    actorId: actor.id,
    actorType: "human",
    action: "checklist.item_removed",
    entity: "checklist_item",
    entityId: itemId,
    metadata: { documentType: item.documentType },
  });
  refreshCaseProgress(item.loanCaseId, actor);
  return true;
}

/* -------------------------------------------------------------------------- */
/* Progress                                                                    */
/* -------------------------------------------------------------------------- */

export interface CaseProgress {
  requiredTotal: number;
  requiredAccepted: number;
  completionPct: number;
  missing: ChecklistItem[];
  rejected: ChecklistItem[];
  awaitingReview: ChecklistItem[];
  optionalOutstanding: ChecklistItem[];
  /** Every required item has a file on it (uploaded or accepted, none rejected). */
  allReceived: boolean;
}

/** Completion counts only *required* items — optional extras must not gate. */
export function caseProgress(loanCaseId: string): CaseProgress {
  const items = checklistFor(loanCaseId);
  const required = items.filter((i) => i.required && i.status !== "NOT_REQUIRED");
  const accepted = required.filter((i) => i.status === "ACCEPTED");

  return {
    requiredTotal: required.length,
    requiredAccepted: accepted.length,
    completionPct: required.length ? Math.round((accepted.length / required.length) * 100) : 0,
    missing: required.filter((i) => ["NOT_REQUESTED", "REQUESTED"].includes(i.status)),
    rejected: items.filter((i) => i.status === "REJECTED"),
    awaitingReview: items.filter((i) => ["UPLOADED", "UNDER_REVIEW"].includes(i.status)),
    optionalOutstanding: items.filter((i) => !i.required && ["NOT_REQUESTED", "REQUESTED"].includes(i.status)),
    allReceived: required.length > 0 && required.every((i) => ["UPLOADED", "UNDER_REVIEW", "ACCEPTED"].includes(i.status)),
  };
}

/** Absolute link to the case for e-mail; relative when no public URL is set. */
export function caseLink(loanCaseId: string): string {
  const base = (process.env.PUBLIC_BASE_URL ?? "").trim().replace(/\/$/, "");
  return `${base}/ops/loans/${loanCaseId}`;
}

/**
 * Tell the assigned officer (or every officer) the case needs them: in-app
 * always, e-mail when configured. E-mail is fire-and-forget — the case state
 * never waits on a mail provider.
 */
function notifyOfficer(loanCase: LoanCase, opts: { event: string; title: string; body: string }): void {
  notify({
    orgId: loanCase.orgId,
    recipientId: loanCase.assignedOfficerId,
    recipientRole: loanCase.assignedOfficerId ? undefined : "LOAN_OFFICER",
    category: "LOAN",
    event: opts.event,
    title: opts.title,
    body: `${opts.body} ${caseLink(loanCase.id)}`,
    customerId: loanCase.customerId,
    severity: "INFO",
  });
  const db = read();
  const officer = db.teamMembers.find((m) => m.id === loanCase.assignedOfficerId);
  const customer = db.customers.find((c) => c.id === loanCase.customerId);
  void import("../notify")
    .then(({ emailConfigured, configuredRecipients, sendEmail }) => {
      if (!emailConfigured()) return;
      const to = [...(officer?.email ? [officer.email] : []), ...configuredRecipients()];
      if (!to.length) return;
      return sendEmail({
        to,
        subject: `${opts.title} — ${customer?.name ?? "customer"}`,
        text: `${opts.body}\n\nCustomer: ${customer?.name ?? "Unknown"} ${customer?.phone ?? ""}\nOpen the case: ${caseLink(loanCase.id)}`,
      });
    })
    .catch((e: unknown) => console.warn(`[loan] officer e-mail failed: ${(e as Error).message}`));
}

/**
 * Recompute derived case state after any checklist change.
 *
 * Reaching 100% flips the case to READY_FOR_ANALYSIS and notifies the officer.
 * The AI is allowed to tell the customer their documents are all *received*; it
 * is never allowed to imply approval, which is a human decision.
 */
export function refreshCaseProgress(loanCaseId: string, actor: { id?: string; type: "human" | "ai" | "system" }): CaseProgress {
  const progress = caseProgress(loanCaseId);
  const loanCase = getCase(loanCaseId);
  if (!loanCase) return progress;

  const terminal = ["APPROVED", "CONDITIONALLY_APPROVED", "REJECTED", "COMPLETED", "ON_HOLD"];
  if (terminal.includes(loanCase.status)) return progress;

  const allAccepted = progress.requiredTotal > 0 && progress.requiredAccepted === progress.requiredTotal;

  if (allAccepted && !loanCase.allDocumentsAcceptedAt) {
    mutate((db) => {
      const l = db.loanCases.find((x) => x.id === loanCaseId);
      if (l) {
        l.allDocumentsAcceptedAt = new Date().toISOString();
        if (!l.readyForReviewAt) l.readyForReviewAt = l.allDocumentsAcceptedAt;
      }
    });
    if (loanCase.status !== "READY_FOR_ANALYSIS") setLoanStatus(loanCaseId, "READY_FOR_ANALYSIS", actor, "All required documents accepted");
    notifyOfficer(getCase(loanCaseId) ?? loanCase, {
      event: "loan_case.documents_accepted",
      title: "All required documents accepted",
      body: `Case is complete (${progress.requiredAccepted}/${progress.requiredTotal}) and ready for analysis.`,
    });
  } else if (progress.allReceived) {
    // Every required file is in hand: the officer can start the analysis now.
    // "Received" is not "accepted" — the customer is told the former only.
    if (loanCase.status !== "READY_FOR_ANALYSIS") {
      setLoanStatus(loanCaseId, "READY_FOR_ANALYSIS", actor, "All required documents received");
      mutate((db) => {
        const l = db.loanCases.find((x) => x.id === loanCaseId);
        if (l && !l.readyForReviewAt) l.readyForReviewAt = new Date().toISOString();
      });
      notifyOfficer(getCase(loanCaseId) ?? loanCase, {
        event: "loan_case.ready_for_analysis",
        title: "All documents received — ready for review",
        body: `Every required document (${progress.requiredTotal}) has been received; ${progress.awaitingReview.length} awaiting your review.`,
      });
    }
  } else if (progress.rejected.length > 0 && loanCase.status !== "DOCUMENTS_INCOMPLETE") {
    setLoanStatus(loanCaseId, "DOCUMENTS_INCOMPLETE", actor, "Documents rejected — replacements required");
  } else if (progress.awaitingReview.length > 0 && progress.missing.length === 0 && loanCase.status !== "UNDER_REVIEW") {
    setLoanStatus(loanCaseId, "UNDER_REVIEW", actor, "Documents awaiting officer review");
  } else if (progress.missing.length > 0 && loanCase.status !== "DOCUMENT_COLLECTION") {
    setLoanStatus(loanCaseId, "DOCUMENT_COLLECTION", actor, "Awaiting customer documents");
  }

  return progress;
}

/** Loan-officer dashboard aggregation. */
export function loanWorkspace(orgId: string, officerId?: string) {
  const db = read();
  const cases = db.loanCases.filter((l) => l.orgId === orgId && (!officerId || l.assignedOfficerId === officerId));
  const now = Date.now();
  const cfg = getConfig(orgId);

  const enriched = cases.map((l) => {
    const progress = caseProgress(l.id);
    const customer = db.customers.find((c) => c.id === l.customerId);
    const lastFollowUp = db.followUps
      .filter((f) => f.loanCaseId === l.id && f.lastSentAt)
      .sort((a, b) => (b.lastSentAt ?? "").localeCompare(a.lastSentAt ?? ""))[0];
    const nextFollowUp = db.followUps
      .filter((f) => f.loanCaseId === l.id && f.status === "SCHEDULED")
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0];
    const overdue =
      progress.awaitingReview.length > 0 &&
      now - new Date(l.updatedAt).getTime() > cfg.sla.documentReviewHours * 3600_000;

    return { loanCase: l, customer, progress, lastFollowUp, nextFollowUp, overdue, checklist: checklistFor(l.id) };
  });

  return {
    all: enriched,
    active: enriched.filter((e) => !["COMPLETED", "REJECTED"].includes(e.loanCase.status)),
    newCases: enriched.filter((e) => e.loanCase.status === "NOT_STARTED"),
    waitingForCustomer: enriched.filter((e) => e.progress.missing.length > 0 || e.progress.rejected.length > 0),
    awaitingReview: enriched.filter((e) => e.progress.awaitingReview.length > 0),
    readyForAnalysis: enriched.filter((e) => e.loanCase.status === "READY_FOR_ANALYSIS"),
    overdue: enriched.filter((e) => e.overdue),
  };
}
