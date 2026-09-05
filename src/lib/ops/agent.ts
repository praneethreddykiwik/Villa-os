import { isUsableConnection } from "../platforms/registry";
import { mutate, read } from "../db";
import { uid } from "../ids";
import { sendWhatsApp } from "../platforms/whatsapp";
import { audit } from "./audit";
import { getConfig } from "./config";
import { automationAllowed, getCustomer, updateCustomer, upsertCustomer } from "./customers";
import { cancelFollowUps, createFollowUp, dueFollowUps, escalate, markSent, syncDocumentFollowUps } from "./followups";
import { deterministicExtract, extractInsight, INTENT_PATTERNS, recordSentiment } from "./intelligence";
import { activeCase, caseProgress } from "./loan";
import { maybeCreateSalesTask } from "./sales";
import { rescoreCustomer } from "./scoring";
import { TOOLS } from "./tools";
import type { OpsMessage } from "./types";

/**
 * WHATSAPP AGENT RUNTIME
 *
 * The rule that governs everything here (§32): **the assistant may only assert
 * an action when the corresponding tool returned ok:true.** Concretely —
 *
 *   - "I've received your document" is sent only after the file is stored and
 *     the checklist item reads UPLOADED.
 *   - "Accepted" is never said by the AI. Only a human review sets ACCEPTED,
 *     and only then does the phrasing change.
 *   - "Approved" is never said at all; approval questions escalate.
 *
 * Composition is deterministic and template-based rather than free-form
 * generation. For a system that tells people what paperwork their loan needs,
 * predictable phrasing bounded by real state is worth more than fluency.
 */

export interface InboundMessage {
  orgId: string;
  phone: string;
  name?: string;
  body: string;
  /** Platform id — the idempotency key. */
  externalId?: string;
  documentId?: string;
  receivedAt?: string;
}

export interface AgentOutcome {
  customerId: string;
  created: boolean;
  /** Null when the agent deliberately stayed silent (human control, opt-out). */
  reply: string | null;
  silentReason?: string;
  insightId?: string;
  salesTaskId?: string;
  escalationId?: string;
  duplicate: boolean;
}

function recordMessage(m: Omit<OpsMessage, "id" | "createdAt"> & { createdAt?: string }): OpsMessage {
  const msg: OpsMessage = { ...m, id: uid("msg"), createdAt: m.createdAt ?? new Date().toISOString() };
  mutate((db) => void db.opsMessages.push(msg));
  return msg;
}

/** Idempotency: WhatsApp redelivers on any non-2xx, and retries are routine. */
function alreadyProcessed(externalId?: string): boolean {
  if (!externalId) return false;
  return read().opsMessages.some((m) => m.externalId === externalId);
}

/**
 * Handle one inbound customer message end to end: persist, extract, score,
 * evaluate triggers, escalate if needed, and compose a grounded reply.
 */
export async function handleInbound(input: InboundMessage): Promise<AgentOutcome> {
  if (alreadyProcessed(input.externalId)) {
    const existing = read().opsMessages.find((m) => m.externalId === input.externalId)!;
    return { customerId: existing.customerId, created: false, reply: null, silentReason: "duplicate webhook", duplicate: true };
  }

  const { customer, created } = upsertCustomer({
    orgId: input.orgId,
    phone: input.phone,
    name: input.name,
    source: "whatsapp",
  });

  const message = recordMessage({
    orgId: input.orgId,
    customerId: customer.id,
    channel: "whatsapp",
    direction: "inbound",
    body: input.body,
    documentId: input.documentId,
    authorType: "customer",
    externalId: input.externalId,
    createdAt: input.receivedAt,
  });

  updateCustomer(customer.id, { lastInteractionAt: message.createdAt }, { type: "system" });

  // Opt-out is an absolute stop, checked before anything else runs.
  if (/\b(stop|unsubscribe|do not (contact|message)|opt.?out)\b/i.test(input.body)) {
    updateCustomer(customer.id, { optedOut: true }, { type: "system" });
    cancelFollowUps({ customerId: customer.id }, "Customer opted out");
    audit({
      orgId: input.orgId,
      actorType: "customer",
      action: "customer.opted_out",
      entity: "customer",
      entityId: customer.id,
      customerId: customer.id,
      metadata: {},
    });
    const reply = "Understood — I won't send you any more automated messages. If you'd like to pick this up again, just reply here.";
    await deliver(input.orgId, customer.id, reply, "ai");
    return { customerId: customer.id, created, reply, duplicate: false };
  }

  const history = read()
    .opsMessages.filter((m) => m.customerId === customer.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((m) => ({ direction: m.direction, body: m.body, createdAt: m.createdAt }));

  const insight = await extractInsight({ orgId: input.orgId, customerId: customer.id, messages: history });

  recordSentiment({
    orgId: input.orgId,
    customerId: customer.id,
    sentiment: insight.sentiment,
    confidence: insight.deterministic ? 0.6 : 0.8,
    intent: insight.intent,
    urgency: INTENT_PATTERNS.urgent.test(input.body) ? "HIGH" : "LOW",
    engagement: history.filter((h) => h.direction === "inbound").length >= 4 ? "HIGH" : "MODERATE",
    objections: insight.objections,
    positiveSignals: insight.buyingSignals,
    sourceMessageId: message.id,
    reason: `Message: "${input.body.slice(0, 80)}"`,
  });

  // Durable facts learned in conversation go onto the profile, not into a blob.
  if (Object.keys(insight.facts).length) {
    TOOLS.update_customer_profile(
      { orgId: input.orgId, customerId: customer.id, actorType: "ai" },
      { preferences: insight.facts },
    );
  }
  if (insight.financingInterest) {
    updateCustomer(customer.id, { loanRequired: customer.loanRequired === "NO" ? "NO" : "YES" }, { type: "ai" });
  }

  rescoreCustomer(customer.id);
  const refreshed = getCustomer(customer.id)!;

  let escalationId: string | undefined;
  for (const rule of escalationChecks(input.body, insight, refreshed)) {
    const e = escalate({ orgId: input.orgId, customerId: customer.id, ...rule });
    if (e) escalationId = e.id;
  }

  const task = maybeCreateSalesTask({ customer: refreshed, insight });

  // A promise to send something becomes a scheduled, contextual follow-up
  // rather than a generic timer.
  if (insight.requiredFollowUp && activeCase(customer.id)) {
    createFollowUp({
      orgId: input.orgId,
      customerId: customer.id,
      kind: "PROMISED_ACTION",
      lane: "LOAN",
      loanCaseId: activeCase(customer.id)!.id,
      reason: insight.requiredFollowUp,
    });
  }

  const allowed = automationAllowed(refreshed, activeCase(customer.id) ? "LOAN" : "SALES");
  if (!allowed.allowed) {
    return {
      customerId: customer.id,
      created,
      reply: null,
      silentReason: allowed.reason,
      insightId: insight.id,
      salesTaskId: task?.id,
      escalationId,
      duplicate: false,
    };
  }

  const reply = composeReply(customer.id, input.body, Boolean(escalationId));
  if (reply) await deliver(input.orgId, customer.id, reply, "ai");

  return {
    customerId: customer.id,
    created,
    reply,
    insightId: insight.id,
    salesTaskId: task?.id,
    escalationId,
    duplicate: false,
  };
}

function escalationChecks(
  body: string,
  insight: ReturnType<typeof deterministicExtract>,
  customer: ReturnType<typeof getCustomer>,
): Array<{ ruleId: string; lane: "SALES" | "LOAN"; severity: "LOW" | "MEDIUM" | "HIGH"; reason: string; detail: string }> {
  const out: Array<{ ruleId: string; lane: "SALES" | "LOAN"; severity: "LOW" | "MEDIUM" | "HIGH"; reason: string; detail: string }> = [];
  if (!customer) return out;
  const cfg = getConfig(customer.orgId);
  const enabled = (id: string) => cfg.escalations.find((e) => e.id === id)?.enabled;

  if (enabled("approval_question") && INTENT_PATTERNS.approval.test(body)) {
    out.push({
      ruleId: "approval_question",
      lane: "LOAN",
      severity: "HIGH",
      reason: "Customer asked about loan approval",
      detail: "Approval and eligibility questions are for authorised loan personnel, not the assistant.",
    });
  }
  if (enabled("document_unavailable") && INTENT_PATTERNS.cannotProvide.test(body)) {
    out.push({
      ruleId: "document_unavailable",
      lane: "LOAN",
      severity: "MEDIUM",
      reason: "Customer says they cannot provide a document",
      detail: `Customer said: "${body.slice(0, 160)}". Asking again would be pointless — a human needs to agree an alternative.`,
    });
  }
  if (enabled("document_disputed") && INTENT_PATTERNS.dispute.test(body)) {
    out.push({
      ruleId: "document_disputed",
      lane: "LOAN",
      severity: "MEDIUM",
      reason: "Customer disputes a requirement",
      detail: `Customer said: "${body.slice(0, 160)}"`,
    });
  }
  if (enabled("requested_human") && insight.requestedHuman) {
    out.push({ ruleId: "requested_human", lane: "SALES", severity: "HIGH", reason: "Customer requested a human", detail: body.slice(0, 160) });
  }
  if (enabled("customer_frustrated") && ["NEGATIVE", "VERY_NEGATIVE"].includes(customer.sentiment)) {
    out.push({ ruleId: "customer_frustrated", lane: "SALES", severity: "HIGH", reason: "Customer sentiment is negative", detail: body.slice(0, 160) });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Reply composition — grounded in tool results only                           */
/* -------------------------------------------------------------------------- */

function sentence(text: string): string {
  const t = text.trim();
  if (!t) return "";
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

export function composeReply(customerId: string, incoming: string, escalated: boolean): string | null {
  const ctx = { orgId: getCustomer(customerId)!.orgId, customerId, actorType: "ai" as const };
  const profile = TOOLS.get_customer_profile(ctx);
  if (!profile.ok) return null;
  const first = profile.data.name.split(" ")[0];
  const greeting = profile.data.name === "Unknown" ? "" : `${first}, `;

  if (INTENT_PATTERNS.approval.test(incoming)) {
    // Never speculate about approval. This is a hard boundary, not a style choice.
    return `${greeting}I can't give you a view on approval — that's decided by our loan team once your file is complete. I've asked them to come back to you on it.`;
  }

  const caseResult = TOOLS.get_loan_case(ctx);
  if (caseResult.ok) {
    const missing = TOOLS.get_missing_documents(ctx);
    if (!missing.ok) return `${greeting}thanks — I'll come back to you shortly.`;
    const { rejected, awaitingReview, missing: outstanding, completionPct } = missing.data;

    if (rejected.length) {
      const r = rejected[0];
      return `${greeting}we need a new copy of your ${r.label}. The team noted: ${sentence(r.reason ?? "it couldn't be accepted as submitted")} You can send the replacement right here.`;
    }
    if (outstanding.length) {
      const next = outstanding[0];
      const pending = awaitingReview.length ? ` Your ${awaitingReview[0].label} is with the team for review.` : "";
      return `${greeting}thanks.${pending} The next thing we need is your ${next.label} — ${sentence(next.description)}`;
    }
    if (awaitingReview.length) {
      // "received", never "accepted": no human has looked at it yet.
      return `${greeting}we've received everything we asked for. It's now with the loan team for review, and we'll come back to you once they've been through it.`;
    }
    if (completionPct === 100) {
      return `${greeting}all the documents we asked for have been received and accepted. Your application is with the loan team now — they'll be in touch with next steps.`;
    }
  }

  if (escalated) {
    return `${greeting}thanks for flagging that — I've passed it to a colleague who'll come back to you directly.`;
  }

  const status = TOOLS.get_lead_status(ctx);
  if (status.ok && ["HOT", "VERY_HOT"].includes(status.data.band)) {
    return notRepeated(customerId, `${greeting}thanks — that's helpful. Someone from the team will call you shortly to go through the details.`);
  }

  // Answer *this* message first. Intent is cumulative across the conversation,
  // so keying only on it makes "is anything available in March?" and "could I
  // see it in person?" collapse into the same reply — which is exactly the kind
  // of not-listening that makes people ask for a human.
  const direct = replyToMessage(incoming, greeting);
  if (direct) return notRepeated(customerId, direct);

  const intent = profile.data.intent;
  const byIntent: Partial<Record<typeof intent, string>> = {
    INTERESTED: `${greeting}thanks for asking — I'll get you the current pricing. Is there a particular unit size you have in mind?`,
    HIGH_INTENT: `${greeting}happy to arrange that. Which days generally suit you?`,
    READY_TO_PROCEED: `${greeting}understood — I'll get someone to walk you through the next steps today.`,
    FINANCING_CONCERN: `${greeting}we can talk through financing options. Roughly what amount were you thinking of borrowing?`,
    PRICE_CONCERN: `${greeting}I hear you on the price. Let me get someone who can talk through what's flexible.`,
    EXPLORING: `${greeting}happy to help you look around. What matters most to you — location, size, or budget?`,
    NOT_INTERESTED: `${greeting}understood, and thanks for letting me know. If anything changes, just reply here.`,
  };

  return notRepeated(
    customerId,
    byIntent[intent] ?? `${greeting}thanks for getting in touch. What would be most useful to know first?`,
  );
}

/**
 * Match the specific thing the customer just asked. Ordered most-specific
 * first, because a message can trip several patterns at once ("what does it
 * cost and can I visit?") and the visit is the more actionable half.
 */
function replyToMessage(incoming: string, greeting: string): string | null {
  if (INTENT_PATTERNS.visit.test(incoming)) {
    return `${greeting}yes — we can arrange a viewing. Which days generally suit you, and roughly what time?`;
  }
  if (INTENT_PATTERNS.availability.test(incoming)) {
    return `${greeting}let me check what's available for that period and come back to you with specifics.`;
  }
  if (INTENT_PATTERNS.financing.test(incoming)) {
    return `${greeting}we can talk through financing. Roughly what amount were you thinking of borrowing?`;
  }
  if (INTENT_PATTERNS.pricing.test(incoming)) {
    return `${greeting}thanks for asking — I'll get you current pricing. Is there a particular size you have in mind?`;
  }
  return null;
}

/**
 * Guard against sending the same sentence twice in a row. Two identical
 * consecutive messages is the most obvious tell that a customer is talking to
 * something that is not reading them.
 */
function notRepeated(customerId: string, candidate: string): string {
  const last = read()
    .opsMessages.filter((m) => m.customerId === customerId && m.direction === "outbound")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (last?.body !== candidate) return candidate;
  return "Still with you — is there anything specific I can dig into for you?";
}

/* -------------------------------------------------------------------------- */
/* Delivery                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Send and persist. The message row is written only after a successful send —
 * recording a message we failed to deliver would corrupt the cooldown and daily
 * cap calculations, and mislead everyone reading the timeline.
 */
export async function deliver(
  orgId: string,
  customerId: string,
  body: string,
  authorType: "ai" | "human",
  authorId?: string,
  opts: { automated?: boolean } = {},
): Promise<{ ok: boolean; error?: string; requiresTemplate?: boolean }> {
  const customer = getCustomer(customerId);
  if (!customer) return { ok: false, error: "Customer not found" };

  const db = read();
  const conn = db.connections.find((c) => c.channel === "whatsapp" && isUsableConnection(c));
  const lastInbound = db.opsMessages
    .filter((m) => m.customerId === customerId && m.direction === "inbound")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  const res = await sendWhatsApp({
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? conn?.externalId ?? "",
    token: conn?.accessToken ?? process.env.META_SYSTEM_USER_TOKEN ?? "",
    to: customer.phone,
    text: body,
    lastInboundAt: lastInbound?.createdAt,
  });

  if (!res.ok) {
    audit({
      orgId,
      actorType: authorType,
      actorId: authorId,
      action: "message.send_failed",
      entity: "customer",
      entityId: customerId,
      customerId,
      metadata: { error: res.error, requiresTemplate: res.requiresTemplate },
    });
    return { ok: false, error: res.error, requiresTemplate: res.requiresTemplate };
  }

  recordMessage({
    orgId,
    customerId,
    channel: "whatsapp",
    direction: "outbound",
    body,
    authorType,
    authorId,
    externalId: res.messageId,
    automated: opts.automated ?? false,
  });
  audit({
    orgId,
    actorType: authorType,
    actorId: authorId,
    action: "message.sent",
    entity: "customer",
    entityId: customerId,
    customerId,
    metadata: { length: body.length, messageId: res.messageId },
  });
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Follow-up worker                                                            */
/* -------------------------------------------------------------------------- */

export interface FollowUpTickResult {
  considered: number;
  sent: number;
  failed: number;
  skipped: Array<{ id: string; reason: string }>;
  escalated: string[];
}

/** Cron entry point. Sends what the guards allow, records what it actually did. */
export async function runFollowUpTick(orgId: string, now = Date.now()): Promise<FollowUpTickResult> {
  const due = dueFollowUps(orgId, now);
  const result: FollowUpTickResult = {
    considered: due.considered,
    sent: 0,
    failed: 0,
    skipped: due.skipped,
    escalated: due.escalated,
  };

  for (const item of due.due) {
    const res = await deliver(orgId, item.followUp.customerId, item.message, "ai", undefined, { automated: true });
    if (res.ok) {
      markSent(item.followUp.id);
      result.sent += 1;
    } else {
      result.failed += 1;
      result.skipped.push({ id: item.followUp.id, reason: res.error ?? "send failed" });
    }
  }
  return result;
}

/**
 * Called after a review decision. Tells the customer what changed — a rejection
 * with the officer's reason, or that everything requested has been received.
 */
export async function notifyDocumentDecision(
  loanCaseId: string,
  checklistItemId: string,
): Promise<{ sent: boolean; reason?: string }> {
  const db = read();
  const loanCase = db.loanCases.find((l) => l.id === loanCaseId);
  const item = db.checklistItems.find((i) => i.id === checklistItemId);
  if (!loanCase || !item) return { sent: false, reason: "case or item not found" };

  const customer = getCustomer(loanCase.customerId);
  if (!customer) return { sent: false, reason: "customer not found" };

  const allowed = automationAllowed(customer, "LOAN");
  if (!allowed.allowed) return { sent: false, reason: allowed.reason };

  syncDocumentFollowUps(loanCaseId);
  const progress = caseProgress(loanCaseId);
  const first = customer.name.split(" ")[0];

  let body: string | null = null;
  if (item.status === "REJECTED") {
    body = `Hi ${first} — we need a clearer copy of your ${item.customerLabel}. The loan team noted: ${sentence(item.rejectionReason ?? "")} Please send a replacement when you can.`;
  } else if (item.status === "ACCEPTED") {
    if (progress.missing.length) {
      const next = progress.missing[0];
      body = `Hi ${first} — your ${item.customerLabel} has been accepted. Next we need your ${next.customerLabel}.`;
    } else if (progress.requiredAccepted === progress.requiredTotal && progress.requiredTotal > 0) {
      body = `Hi ${first} — that's everything we asked for, all received and accepted. Your application is now with the loan team for review and they'll be in touch with next steps.`;
    } else {
      body = `Hi ${first} — your ${item.customerLabel} has been accepted. We'll let you know once the team has reviewed the rest.`;
    }
  }

  if (!body) return { sent: false, reason: `no message for status ${item.status}` };

  const res = await deliver(loanCase.orgId, loanCase.customerId, body, "ai", undefined, { automated: true });
  if (!res.ok) {
    // The decision stands, but nobody told the customer. Silently swallowing
    // this is how a rejected document sits untouched for a week — so it becomes
    // a human's task instead of a lost message.
    escalate({
      orgId: loanCase.orgId,
      customerId: loanCase.customerId,
      ruleId: "notification_failed",
      lane: "LOAN",
      severity: res.requiresTemplate ? "MEDIUM" : "HIGH",
      reason: "Could not tell the customer about a document decision",
      detail: res.requiresTemplate
        ? `The 24-hour messaging window has closed, so "${item.customerLabel}" (${item.status}) could not be sent as free text. Send an approved template or call them.`
        : `Delivery failed: ${res.error}`,
    });
  }
  return { sent: res.ok, reason: res.error };
}
