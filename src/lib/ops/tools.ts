import { read } from "../db";
import { getConfig } from "./config";
import { automationAllowed, getCustomer, setControl, updateCustomer } from "./customers";
import { cancelFollowUps, createFollowUp, escalate } from "./followups";
import { activeCase, caseProgress, checklistFor } from "./loan";
import { buildBriefing, maybeCreateSalesTask } from "./sales";
import { sentimentTimeline, sentimentTrend } from "./intelligence";
import type { FollowUpKind, Intent, Sentiment } from "./types";

/**
 * AI TOOL LAYER
 *
 * The assistant reads and writes state exclusively through these tools. It never
 * infers what documents are needed, never guesses a case status, and never
 * assumes a write succeeded.
 *
 * Every tool returns a discriminated result — `{ok:true,data}` or
 * `{ok:false,error}`. That shape is the mechanism behind the rule in §32: the
 * agent may only describe an action as done when it holds an `ok:true` result.
 * A tool that throws is caught here and converted to `ok:false`, so a runtime
 * failure can never be silently narrated as success.
 */

export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: string };

function ok<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}
function fail<T = never>(error: string): ToolResult<T> {
  return { ok: false, error };
}

/** Wraps a tool so an exception becomes a failed result, never a false success. */
function guard<A extends unknown[], T>(fn: (...args: A) => ToolResult<T>) {
  return (...args: A): ToolResult<T> => {
    try {
      return fn(...args);
    } catch (e) {
      return fail<T>((e as Error).message);
    }
  };
}

export interface ToolContext {
  orgId: string;
  customerId: string;
  /** Who is invoking — the agent, or a human acting through the UI. */
  actorType: "ai" | "human" | "system";
  actorId?: string;
}

/* -------------------------------------------------------------------------- */

export const get_customer_profile = guard((ctx: ToolContext) => {
  const c = getCustomer(ctx.customerId);
  if (!c) return fail("Customer not found");
  return ok({
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    leadStage: c.leadStage,
    leadScore: c.leadScore,
    intent: c.intent,
    sentiment: c.sentiment,
    loanRequired: c.loanRequired,
    preferences: c.preferences,
    tags: c.tags,
    salesControl: c.salesControl,
    loanControl: c.loanControl,
    optedOut: c.optedOut,
  });
});

export const get_lead_status = guard((ctx: ToolContext) => {
  const c = getCustomer(ctx.customerId);
  if (!c) return fail("Customer not found");
  const cfg = getConfig(ctx.orgId);
  return ok({
    stage: c.leadStage,
    status: c.leadStatus,
    score: c.leadScore,
    band: c.leadScore <= cfg.scoring.bands.cold ? "COLD" : c.leadScore <= cfg.scoring.bands.warm ? "WARM" : c.leadScore <= cfg.scoring.bands.hot ? "HOT" : "VERY_HOT",
    assignedSalesManagerId: c.assignedSalesManagerId,
    assignedLoanOfficerId: c.assignedLoanOfficerId,
  });
});

export const update_customer_profile = guard(
  (ctx: ToolContext, patch: { name?: string; email?: string; preferences?: Record<string, string>; notes?: string; tags?: string[]; budgetMin?: number; budgetMax?: number; purchaseInfo?: string; financingInfo?: string }) => {
    const current = getCustomer(ctx.customerId);
    if (!current) return fail("Customer not found");
    // Merge preferences rather than replacing: each extraction learns one fact.
    const merged = patch.preferences ? { ...current.preferences, ...patch.preferences } : undefined;
    const updated = updateCustomer(
      ctx.customerId,
      { ...patch, ...(merged ? { preferences: merged } : {}) },
      { id: ctx.actorId, type: ctx.actorType },
    );
    return updated ? ok({ updated: true, customerId: updated.id }) : fail("Update failed");
  },
);

export const get_sentiment = guard((ctx: ToolContext) => {
  const c = getCustomer(ctx.customerId);
  if (!c) return fail("Customer not found");
  return ok({
    sentiment: c.sentiment,
    confidence: c.sentimentConfidence,
    intent: c.intent,
    trend: sentimentTrend(ctx.customerId),
    history: sentimentTimeline(ctx.customerId).slice(-10).map((e) => ({
      sentiment: e.sentiment,
      intent: e.intent,
      at: e.createdAt,
      reason: e.reason,
    })),
  });
});

export const create_sales_task = guard((ctx: ToolContext, args: { reason?: string }) => {
  const c = getCustomer(ctx.customerId);
  if (!c) return fail("Customer not found");
  const task = maybeCreateSalesTask({ customer: c, aiUncertain: true });
  if (!task) return fail(args.reason ? `No configured trigger matched: ${args.reason}` : "No configured trigger matched");
  return ok({ taskId: task.id, priority: task.priority, assignedToId: task.assignedToId, status: task.status });
});

export const get_conversation_summary = guard((ctx: ToolContext) => {
  const briefing = buildBriefing(ctx.customerId);
  return ok({ summary: briefing.text, fields: briefing.fields, recommendedAction: briefing.recommendedAction });
});

/* -------------------------------------------------------------------------- */
/* Loan & documents                                                            */
/* -------------------------------------------------------------------------- */

export const get_loan_case = guard((ctx: ToolContext) => {
  const c = activeCase(ctx.customerId);
  if (!c) return fail("No active loan case for this customer");
  return ok({
    id: c.id,
    status: c.status,
    loanType: c.loanType,
    requestedAmount: c.requestedAmount,
    assignedOfficerId: c.assignedOfficerId,
    readyForReviewAt: c.readyForReviewAt,
  });
});

export const get_assigned_loan_officer = guard((ctx: ToolContext) => {
  const c = getCustomer(ctx.customerId);
  if (!c?.assignedLoanOfficerId) return fail("No loan officer assigned");
  const m = read().teamMembers.find((x) => x.id === c.assignedLoanOfficerId);
  return m ? ok({ id: m.id, name: m.name }) : fail("Assigned officer not found");
});

/**
 * The assistant's only source of document requirements. There is deliberately
 * no tool to *add* a checklist item: requirements come from the loan department.
 */
export const get_document_checklist = guard((ctx: ToolContext) => {
  const c = activeCase(ctx.customerId);
  if (!c) return fail("No active loan case");
  const items = checklistFor(c.id);
  if (!items.length) return fail("No checklist has been configured yet");
  return ok(
    items.map((i) => ({
      id: i.id,
      label: i.customerLabel,
      description: i.description,
      required: i.required,
      status: i.status,
      acceptedFormats: i.acceptedFormats,
      rejectionReason: i.rejectionReason,
    })),
  );
});

export const get_missing_documents = guard((ctx: ToolContext) => {
  const c = activeCase(ctx.customerId);
  if (!c) return fail("No active loan case");
  const p = caseProgress(c.id);
  return ok({
    completionPct: p.completionPct,
    requiredTotal: p.requiredTotal,
    requiredAccepted: p.requiredAccepted,
    missing: p.missing.map((i) => ({ id: i.id, label: i.customerLabel, description: i.description })),
    rejected: p.rejected.map((i) => ({ id: i.id, label: i.customerLabel, reason: i.rejectionReason })),
    awaitingReview: p.awaitingReview.map((i) => ({ id: i.id, label: i.customerLabel })),
    optionalOutstanding: p.optionalOutstanding.map((i) => ({ id: i.id, label: i.customerLabel })),
  });
});

export const get_document_status = guard((ctx: ToolContext, args: { checklistItemId: string }) => {
  const item = read().checklistItems.find((i) => i.id === args.checklistItemId);
  if (!item) return fail("Checklist item not found");
  return ok({
    label: item.customerLabel,
    status: item.status,
    rejectionReason: item.rejectionReason,
    // Explicit, so the agent cannot infer acceptance from "uploaded".
    acceptedByHuman: item.status === "ACCEPTED",
  });
});

/**
 * Records that a customer said they sent something. It does NOT create a
 * document — that only happens when a file actually arrives and is stored.
 */
export const record_document_received = guard((ctx: ToolContext, args: { checklistItemId: string; note?: string }) => {
  const item = read().checklistItems.find((i) => i.id === args.checklistItemId);
  if (!item) return fail("Checklist item not found");
  if (item.status !== "UPLOADED") {
    return fail(`No file has been stored for ${item.customerLabel}; its status is ${item.status}`);
  }
  return ok({ label: item.customerLabel, status: item.status, note: args.note });
});

/* -------------------------------------------------------------------------- */
/* Follow-ups & escalation                                                     */
/* -------------------------------------------------------------------------- */

export const create_followup = guard(
  (ctx: ToolContext, args: { kind: FollowUpKind; lane: "SALES" | "LOAN"; reason: string; scheduledAt?: string; checklistItemId?: string }) => {
    const c = getCustomer(ctx.customerId);
    if (!c) return fail("Customer not found");
    const allowed = automationAllowed(c, args.lane);
    if (!allowed.allowed) return fail(allowed.reason!);
    const f = createFollowUp({
      orgId: ctx.orgId,
      customerId: ctx.customerId,
      kind: args.kind,
      lane: args.lane,
      reason: args.reason,
      scheduledAt: args.scheduledAt,
      checklistItemId: args.checklistItemId,
      loanCaseId: activeCase(ctx.customerId)?.id,
    });
    return f ? ok({ followUpId: f.id, scheduledAt: f.scheduledAt }) : fail("Could not create follow-up");
  },
);

export const pause_followups = guard((ctx: ToolContext, args: { lane: "SALES" | "LOAN"; reason: string }) => {
  const n = cancelFollowUps({ customerId: ctx.customerId }, args.reason);
  setControl(ctx.customerId, args.lane, "HUMAN_CONTROL", { id: ctx.actorId, type: ctx.actorType });
  return ok({ cancelled: n, lane: args.lane });
});

export const escalate_to_human = guard(
  (ctx: ToolContext, args: { ruleId: string; lane: "SALES" | "LOAN"; reason: string; detail: string; severity?: "LOW" | "MEDIUM" | "HIGH" }) => {
    const e = escalate({
      orgId: ctx.orgId,
      customerId: ctx.customerId,
      ruleId: args.ruleId,
      lane: args.lane,
      severity: args.severity ?? "MEDIUM",
      reason: args.reason,
      detail: args.detail,
    });
    return e ? ok({ escalationId: e.id, status: e.status, assignedToId: e.assignedToId }) : fail("Could not escalate");
  },
);

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

export interface ToolSpec {
  name: string;
  description: string;
  /** Whether the tool changes state — used for logging and dry-run modes. */
  mutating: boolean;
}

export const TOOL_SPECS: ToolSpec[] = [
  { name: "get_customer_profile", description: "Read the canonical customer profile", mutating: false },
  { name: "get_lead_status", description: "Read lead stage, score and owners", mutating: false },
  { name: "update_customer_profile", description: "Merge newly-learned facts into the profile", mutating: true },
  { name: "get_sentiment", description: "Read current sentiment, trend and history", mutating: false },
  { name: "create_sales_task", description: "Hand the customer to a sales manager", mutating: true },
  { name: "get_conversation_summary", description: "Read the AI briefing for this customer", mutating: false },
  { name: "get_loan_case", description: "Read the active loan case", mutating: false },
  { name: "get_assigned_loan_officer", description: "Read the assigned loan officer", mutating: false },
  { name: "get_document_checklist", description: "Read the loan department's configured checklist", mutating: false },
  { name: "get_missing_documents", description: "Read outstanding, rejected and pending documents", mutating: false },
  { name: "get_document_status", description: "Read the status of one checklist item", mutating: false },
  { name: "record_document_received", description: "Confirm a file was actually stored for an item", mutating: false },
  { name: "create_followup", description: "Schedule a follow-up", mutating: true },
  { name: "pause_followups", description: "Stop automation and hand to a human", mutating: true },
  { name: "escalate_to_human", description: "Raise an escalation for a human to handle", mutating: true },
];

export const TOOLS = {
  get_customer_profile,
  get_lead_status,
  update_customer_profile,
  get_sentiment,
  create_sales_task,
  get_conversation_summary,
  get_loan_case,
  get_assigned_loan_officer,
  get_document_checklist,
  get_missing_documents,
  get_document_status,
  record_document_received,
  create_followup,
  pause_followups,
  escalate_to_human,
};

export type ToolName = keyof typeof TOOLS;

export type { Intent, Sentiment };
