import { mutate, read } from "../db";
import { uid } from "../ids";
import { audit, notify } from "./audit";
import { getConfig } from "./config";
import { automationAllowed, getCustomer } from "./customers";
import { caseProgress, checklistFor, getCase } from "./loan";
import { isWithinServiceWindow } from "../platforms/whatsapp";
import type { Escalation, FollowUp, FollowUpKind, WorkflowConfig } from "./types";

/**
 * FOLLOW-UP ENGINE
 *
 * The difference between a helpful assistant and a nuisance is entirely in this
 * file. Four guards, all configurable, all enforced before a message can be sent:
 *
 *  1. **Quiet hours** — nothing sends between the configured hours. Chasing a
 *     bank statement at 2am is how you lose a customer.
 *  2. **Cooldown** — a minimum gap between any two automated messages, across
 *     all follow-ups, so three pending items do not produce three pings at once.
 *  3. **Daily cap** — a hard ceiling per customer per day.
 *  4. **Max attempts → escalate** — automation gives up and hands to a human
 *     rather than repeating itself indefinitely.
 *
 * Plus two absolute stops: customer opt-out, and human control of that lane.
 */

const HOUR = 3600_000;
const DAY = 86400_000;

function scheduleFor(cfg: WorkflowConfig, kind: FollowUpKind) {
  return cfg.followUps.find((f) => f.kind === kind);
}

/** In the org's configured timezone, not the server's. */
function localHour(iso: string, timezone: string): number {
  try {
    return Number(
      new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: timezone }).format(new Date(iso)),
    );
  } catch {
    return new Date(iso).getUTCHours();
  }
}

/** Push a timestamp forward out of quiet hours. */
export function nextSendableTime(iso: string, cfg: WorkflowConfig): string {
  const { quietHoursStart, quietHoursEnd, timezone } = cfg.messaging;
  let t = new Date(iso).getTime();
  for (let i = 0; i < 48; i++) {
    const h = localHour(new Date(t).toISOString(), timezone);
    const quiet = quietHoursStart > quietHoursEnd ? h >= quietHoursStart || h < quietHoursEnd : h >= quietHoursStart && h < quietHoursEnd;
    if (!quiet) return new Date(t).toISOString();
    t += HOUR;
  }
  return new Date(t).toISOString();
}

export interface CreateFollowUpInput {
  orgId: string;
  customerId: string;
  kind: FollowUpKind;
  lane: "SALES" | "LOAN";
  reason: string;
  loanCaseId?: string;
  checklistItemId?: string;
  /** Overrides the schedule's first step — used for customer-promised times. */
  scheduledAt?: string;
  message?: string;
}

/**
 * Create a follow-up. Idempotent per (customer, kind, checklistItem): asking
 * twice for the same document is the single most common way these systems annoy
 * people.
 */
export function createFollowUp(input: CreateFollowUpInput): FollowUp | null {
  const cfg = getConfig(input.orgId);
  const schedule = scheduleFor(cfg, input.kind);
  const db = read();

  const existing = db.followUps.find(
    (f) =>
      f.customerId === input.customerId &&
      f.kind === input.kind &&
      f.checklistItemId === input.checklistItemId &&
      ["SCHEDULED", "SENT", "PAUSED"].includes(f.status),
  );
  if (existing) return existing;

  const firstStepDays = schedule?.steps[0]?.afterDays ?? 0;
  const base = input.scheduledAt ?? new Date(Date.now() + firstStepDays * DAY).toISOString();
  const now = new Date().toISOString();

  const followUp: FollowUp = {
    id: uid("fup"),
    orgId: input.orgId,
    customerId: input.customerId,
    loanCaseId: input.loanCaseId,
    checklistItemId: input.checklistItemId,
    kind: input.kind,
    lane: input.lane,
    scheduledAt: nextSendableTime(base, cfg),
    attempts: 0,
    maxAttempts: schedule?.maxAttempts ?? 3,
    status: "SCHEDULED",
    message: input.message,
    reason: input.reason,
    createdAt: now,
    updatedAt: now,
  };

  mutate((d) => void d.followUps.push(followUp));
  audit({
    orgId: input.orgId,
    actorType: "ai",
    action: "followup.scheduled",
    entity: "followup",
    entityId: followUp.id,
    customerId: input.customerId,
    metadata: { kind: input.kind, scheduledAt: followUp.scheduledAt, reason: input.reason },
  });
  return followUp;
}

export function cancelFollowUps(
  filter: { customerId: string; checklistItemId?: string; kind?: FollowUpKind },
  reason: string,
): number {
  let n = 0;
  const now = new Date().toISOString();
  mutate((db) => {
    for (const f of db.followUps) {
      if (f.customerId !== filter.customerId) continue;
      if (filter.checklistItemId && f.checklistItemId !== filter.checklistItemId) continue;
      if (filter.kind && f.kind !== filter.kind) continue;
      if (!["SCHEDULED", "SENT", "PAUSED"].includes(f.status)) continue;
      f.status = "CANCELLED";
      f.cancelledReason = reason;
      f.updatedAt = now;
      n += 1;
    }
  });
  if (n) {
    const orgId = getCustomer(filter.customerId)?.orgId;
    if (orgId) {
      audit({
        orgId,
        actorType: "system",
        action: "followup.cancelled",
        entity: "customer",
        entityId: filter.customerId,
        customerId: filter.customerId,
        metadata: { count: n, reason, ...filter },
      });
    }
  }
  return n;
}

/* -------------------------------------------------------------------------- */
/* Message composition                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Templates read the *live* checklist. The assistant can only ever ask for
 * documents the loan department configured — it has no vocabulary of its own.
 */
/** Officer-authored text is free-form; terminate it before concatenating. */
function sentence(text: string): string {
  const t = text.trim();
  if (!t) return "";
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

export function composeMessage(followUp: FollowUp, step: number): string | null {
  const db = read();
  const customer = db.customers.find((c) => c.id === followUp.customerId);
  if (!customer) return null;
  const first = customer.name.split(" ")[0] ?? "there";

  const item = followUp.checklistItemId ? db.checklistItems.find((i) => i.id === followUp.checklistItemId) : undefined;

  if (followUp.kind === "DOCUMENT_REJECTED" && item) {
    const why = item.rejectionReason ?? "the document could not be accepted as submitted";
    return step === 0
      ? `Hi ${first} — we need a new copy of your ${item.customerLabel}. The team noted: ${sentence(why)} Could you send it again when you get a moment?`
      : `Hi ${first}, just following up on the replacement ${item.customerLabel} — we still need it to continue.`;
  }

  if ((followUp.kind === "DOCUMENT_REQUEST" || followUp.kind === "DOCUMENT_REMINDER") && followUp.loanCaseId) {
    const progress = caseProgress(followUp.loanCaseId);
    const missing = progress.missing;
    if (!missing.length) return null;
    // Progressive: ask for one thing at a time, never paste the whole checklist.
    const next = missing[0];
    if (step === 0) {
      return `Hi ${first} — to move your application forward, the next thing we need is your ${next.customerLabel}. ${sentence(next.description)} You can send it right here.`;
    }
    if (step === 1) {
      return `Hi ${first}, just a gentle reminder about your ${next.customerLabel} — send it over whenever you're ready and we'll keep things moving.`;
    }
    if (step === 2) {
      const remaining = missing.length > 1 ? ` (${missing.length} items still outstanding)` : "";
      return `Hi ${first}, we're still waiting on your ${next.customerLabel}${remaining}. Is there anything making it difficult to send? Happy to help.`;
    }
    return `Hi ${first}, we haven't been able to progress your application without your ${next.customerLabel}. I'll ask someone from the team to reach out directly.`;
  }

  if (followUp.kind === "PROMISED_ACTION") {
    const what = item ? item.customerLabel : "the document you mentioned";
    return `Hi ${first} — following up on ${what} you were going to send. No rush, just keeping it on our radar.`;
  }

  if (followUp.kind === "NO_RESPONSE") {
    return step === 0
      ? `Hi ${first} — just checking in. Is there anything you'd like to know, or anything holding things up?`
      : `Hi ${first}, I'll stop chasing for now. If you'd like to pick this up again, just reply here any time.`;
  }

  if (followUp.kind === "SALES_NUDGE") {
    return `Hi ${first} — checking in on your enquiry. Would it help to arrange a call?`;
  }

  return followUp.message ?? null;
}

/* -------------------------------------------------------------------------- */
/* Due processing                                                              */
/* -------------------------------------------------------------------------- */

export interface DueFollowUp {
  followUp: FollowUp;
  message: string;
  step: number;
}

export interface TickResult {
  considered: number;
  due: DueFollowUp[];
  skipped: Array<{ id: string; reason: string }>;
  escalated: string[];
}

/**
 * Decide what may be sent right now. Pure with respect to messaging — it does
 * not send anything, it returns what *should* be sent. The caller (the WhatsApp
 * runtime) performs delivery and calls `markSent`, which keeps the guard logic
 * testable without a network.
 */
export function dueFollowUps(orgId: string, now = Date.now()): TickResult {
  const db = read();
  const cfg = getConfig(orgId);
  const result: TickResult = { considered: 0, due: [], skipped: [], escalated: [] };

  const scheduled = db.followUps.filter(
    (f) => f.orgId === orgId && f.status === "SCHEDULED" && new Date(f.scheduledAt).getTime() <= now,
  );

  for (const f of scheduled) {
    result.considered += 1;
    const customer = db.customers.find((c) => c.id === f.customerId);
    if (!customer) {
      result.skipped.push({ id: f.id, reason: "customer missing" });
      continue;
    }

    const allowed = automationAllowed(customer, f.lane);
    if (!allowed.allowed) {
      result.skipped.push({ id: f.id, reason: allowed.reason! });
      continue;
    }

    // A window-blocked reply can only go out once the customer writes again.
    // Until then it is not "due": attempting it would fail before delivery,
    // never count as an attempt, and write a send_failed audit row per tick —
    // forever. The window is judged against real time, like the transport does.
    const lastInbound = db.opsMessages
      .filter((m) => m.customerId === f.customerId && m.direction === "inbound")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (f.kind === "TEMPLATE_REQUIRED" && !isWithinServiceWindow(lastInbound?.createdAt)) {
      result.skipped.push({ id: f.id, reason: "24h window closed" });
      continue;
    }
    // A document reminder is free text too: once the customer has gone quiet
    // for a day it cannot be delivered, so it waits for them to write again.
    if (["DOCUMENT_REQUEST", "DOCUMENT_REMINDER", "DOCUMENT_REJECTED"].includes(f.kind) && lastInbound && !isWithinServiceWindow(lastInbound.createdAt)) {
      result.skipped.push({ id: f.id, reason: "24h window closed" });
      continue;
    }

    if (f.attempts >= f.maxAttempts) {
      escalate({
        orgId,
        customerId: f.customerId,
        ruleId: "followups_exhausted",
        lane: f.lane,
        severity: "MEDIUM",
        reason: "Follow-up attempts exhausted",
        detail: `${f.attempts} attempts on ${f.kind} with no response.`,
      });
      mutate((d) => {
        const x = d.followUps.find((y) => y.id === f.id);
        if (x) {
          x.status = "ESCALATED";
          x.updatedAt = new Date(now).toISOString();
        }
      });
      result.escalated.push(f.id);
      continue;
    }

    // Cooldown applies across every automated message to this customer, not
    // per follow-up — otherwise three items produce three simultaneous pings.
    const lastAutomated = db.opsMessages
      .filter((m) => m.customerId === f.customerId && m.direction === "outbound" && m.automated === true)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const schedule = scheduleFor(cfg, f.kind);
    const cooldown = (schedule?.cooldownHours ?? 20) * HOUR;
    if (lastAutomated && now - new Date(lastAutomated.createdAt).getTime() < cooldown) {
      result.skipped.push({ id: f.id, reason: "cooldown" });
      continue;
    }

    const sentToday = db.opsMessages.filter(
      (m) =>
        m.customerId === f.customerId &&
        m.direction === "outbound" &&
        m.automated === true &&
        now - new Date(m.createdAt).getTime() < DAY,
    ).length;
    if (sentToday >= cfg.messaging.maxAutomatedPerDay) {
      result.skipped.push({ id: f.id, reason: "daily cap reached" });
      continue;
    }

    const hour = localHour(new Date(now).toISOString(), cfg.messaging.timezone);
    const { quietHoursStart: qs, quietHoursEnd: qe } = cfg.messaging;
    const quiet = qs > qe ? hour >= qs || hour < qe : hour >= qs && hour < qe;
    if (quiet) {
      result.skipped.push({ id: f.id, reason: "quiet hours" });
      continue;
    }

    const message = composeMessage(f, f.attempts);
    if (!message) {
      // Nothing left to ask for — the reason for this follow-up is gone.
      cancelFollowUps({ customerId: f.customerId, checklistItemId: f.checklistItemId, kind: f.kind }, "Nothing outstanding");
      result.skipped.push({ id: f.id, reason: "no outstanding item" });
      continue;
    }

    result.due.push({ followUp: f, message, step: f.attempts });
  }

  return result;
}

/** Record a successful send and schedule the next step. */
export function markSent(followUpId: string): FollowUp | null {
  const cfg0 = read().followUps.find((f) => f.id === followUpId);
  if (!cfg0) return null;
  const cfg = getConfig(cfg0.orgId);
  const schedule = scheduleFor(cfg, cfg0.kind);
  const now = new Date();

  const updated = mutate((db) => {
    const f = db.followUps.find((x) => x.id === followUpId);
    if (!f) return null;
    f.attempts += 1;
    f.lastSentAt = now.toISOString();
    f.updatedAt = now.toISOString();

    const nextStep = schedule?.steps[f.attempts];
    if (nextStep && f.attempts < f.maxAttempts) {
      f.status = "SCHEDULED";
      f.scheduledAt = nextSendableTime(new Date(now.getTime() + nextStep.afterDays * DAY).toISOString(), cfg);
    } else {
      f.status = "SENT";
    }
    return { ...f };
  });

  // The last reminder went out and the documents are still missing: the
  // chase is exhausted, and a person takes over rather than silence.
  if (
    updated &&
    updated.status === "SENT" &&
    updated.loanCaseId &&
    ["DOCUMENT_REQUEST", "DOCUMENT_REMINDER", "DOCUMENT_REJECTED"].includes(updated.kind) &&
    updated.attempts >= (schedule?.escalateAfterAttempts ?? updated.maxAttempts)
  ) {
    const progress = caseProgress(updated.loanCaseId);
    if (progress.missing.length || progress.rejected.length) {
      escalate({
        orgId: updated.orgId,
        customerId: updated.customerId,
        ruleId: "followups_exhausted",
        lane: "LOAN",
        severity: "MEDIUM",
        reason: "Follow-up attempts exhausted",
        detail: `${updated.attempts} reminders sent; still missing: ${[...progress.rejected, ...progress.missing].map((i) => i.customerLabel).join(", ")}.`,
      });
      mutate((d) => {
        const f = d.followUps.find((x) => x.id === followUpId);
        if (f) f.status = "ESCALATED";
      });
      return read().followUps.find((x) => x.id === followUpId) ?? updated;
    }
  }
  return updated;
}

/* -------------------------------------------------------------------------- */
/* Escalation                                                                  */
/* -------------------------------------------------------------------------- */

export function escalate(input: {
  orgId: string;
  customerId: string;
  ruleId: string;
  lane: "SALES" | "LOAN";
  severity: Escalation["severity"];
  reason: string;
  detail: string;
  assignedToId?: string;
}): Escalation | null {
  const db = read();
  // One open escalation per (customer, rule) — repeating the same alert trains
  // people to ignore all of them.
  const existing = db.escalations.find(
    (e) => e.customerId === input.customerId && e.ruleId === input.ruleId && e.status === "OPEN",
  );
  if (existing) return existing;

  const customer = db.customers.find((c) => c.id === input.customerId);
  const assignedToId =
    input.assignedToId ?? (input.lane === "SALES" ? customer?.assignedSalesManagerId : customer?.assignedLoanOfficerId);

  const escalation: Escalation = {
    id: uid("esc"),
    orgId: input.orgId,
    customerId: input.customerId,
    ruleId: input.ruleId,
    lane: input.lane,
    severity: input.severity,
    reason: input.reason,
    detail: input.detail,
    assignedToId,
    status: "OPEN",
    createdAt: new Date().toISOString(),
  };

  mutate((d) => void d.escalations.push(escalation));
  audit({
    orgId: input.orgId,
    actorType: "ai",
    action: "escalation.created",
    entity: "escalation",
    entityId: escalation.id,
    customerId: input.customerId,
    metadata: { ruleId: input.ruleId, severity: input.severity, reason: input.reason },
  });
  notify({
    orgId: input.orgId,
    recipientId: assignedToId,
    recipientRole: assignedToId ? undefined : input.lane === "SALES" ? "SALES_MANAGER" : "LOAN_OFFICER",
    category: input.lane === "SALES" ? "SALES" : "LOAN",
    event: "escalation.created",
    title: `Escalation: ${input.reason}`,
    body: input.detail,
    customerId: input.customerId,
    severity: input.severity === "HIGH" ? "CRITICAL" : "WARNING",
  });
  return escalation;
}

export function resolveEscalation(id: string, memberId: string): Escalation | null {
  const now = new Date().toISOString();
  const updated = mutate((db) => {
    const e = db.escalations.find((x) => x.id === id);
    if (!e) return null;
    e.status = "RESOLVED";
    e.resolvedAt = now;
    e.resolvedById = memberId;
    return { ...e };
  });
  if (updated) {
    audit({
      orgId: updated.orgId,
      actorId: memberId,
      actorType: "human",
      action: "escalation.resolved",
      entity: "escalation",
      entityId: id,
      customerId: updated.customerId,
      metadata: {},
    });
  }
  return updated;
}

/**
 * Ensure a document-collection follow-up exists for whatever is outstanding.
 * Called after checklist changes and after each review decision.
 */
export function syncDocumentFollowUps(loanCaseId: string): FollowUp[] {
  const loanCase = getCase(loanCaseId);
  if (!loanCase) return [];
  const items = checklistFor(loanCaseId);
  const created: FollowUp[] = [];

  for (const item of items.filter((i) => i.status === "REJECTED")) {
    const f = createFollowUp({
      orgId: loanCase.orgId,
      customerId: loanCase.customerId,
      kind: "DOCUMENT_REJECTED",
      lane: "LOAN",
      loanCaseId,
      checklistItemId: item.id,
      reason: `Replacement needed for ${item.customerLabel}`,
      scheduledAt: new Date().toISOString(),
    });
    if (f) created.push(f);
  }

  const progress = caseProgress(loanCaseId);
  if (progress.missing.length > 0) {
    const f = createFollowUp({
      orgId: loanCase.orgId,
      customerId: loanCase.customerId,
      kind: "DOCUMENT_REQUEST",
      lane: "LOAN",
      loanCaseId,
      reason: `${progress.missing.length} required document(s) outstanding`,
      scheduledAt: new Date().toISOString(),
    });
    if (f) created.push(f);
  } else {
    cancelFollowUps({ customerId: loanCase.customerId, kind: "DOCUMENT_REQUEST" }, "All required documents received");
  }

  // An accepted document ends any chase for that specific item.
  for (const item of items.filter((i) => i.status === "ACCEPTED")) {
    cancelFollowUps({ customerId: loanCase.customerId, checklistItemId: item.id }, "Document accepted");
  }

  return created;
}
