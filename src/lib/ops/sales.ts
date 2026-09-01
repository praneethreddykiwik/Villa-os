import { mutate, read } from "../db";
import { uid } from "../ids";
import { assign } from "./assignment";
import { audit, notify } from "./audit";
import { getConfig } from "./config";
import { getCustomer, setStage } from "./customers";
import { sentimentTrend } from "./intelligence";
import type { ConversationInsight, Customer, SalesTask, SalesTaskStatus } from "./types";

/**
 * SALES HANDOFF
 *
 * Trigger evaluation is a pure function of state + the latest insight. It
 * returns which configured triggers fired; creating the task is a separate,
 * idempotent step. Keeping those apart means the rules can be unit-tested and
 * previewed in the admin UI without side effects.
 */

export interface TriggerContext {
  customer: Customer;
  insight?: ConversationInsight;
  aiUncertain?: boolean;
  aiConfidence?: number;
}

export interface FiredTrigger {
  id: string;
  label: string;
  priority: SalesTask["priority"];
  reason: string;
}

export function evaluateTriggers(ctx: TriggerContext): FiredTrigger[] {
  const cfg = getConfig(ctx.customer.orgId);
  const fired: FiredTrigger[] = [];

  for (const rule of cfg.salesTriggers) {
    if (!rule.enabled) continue;
    let hit = false;
    let reason = rule.label;

    switch (rule.id) {
      case "high_intent":
        hit = ["HIGH_INTENT", "READY_TO_PROCEED"].includes(ctx.customer.intent);
        reason = `Intent is ${ctx.customer.intent}`;
        break;
      case "requested_human":
        hit = Boolean(ctx.insight?.requestedHuman) || ctx.customer.intent === "HUMAN_HELP_REQUIRED";
        reason = "Customer asked to speak to a person";
        break;
      case "score_threshold":
        hit = ctx.customer.leadScore >= cfg.scoring.bands.hot;
        reason = `Lead score ${ctx.customer.leadScore} crossed the hot threshold (${cfg.scoring.bands.hot})`;
        break;
      case "negative_sentiment":
        hit = ["NEGATIVE", "VERY_NEGATIVE"].includes(ctx.customer.sentiment);
        reason = `Sentiment is ${ctx.customer.sentiment} — needs human intervention`;
        break;
      case "ai_uncertain":
        hit = Boolean(ctx.aiUncertain) || (ctx.aiConfidence ?? 1) < 0.5;
        reason = "The assistant could not answer confidently";
        break;
      case "financing_concern":
        hit = ctx.customer.intent === "FINANCING_CONCERN" || Boolean(ctx.insight?.financingInterest);
        reason = "Customer raised financing";
        break;
    }

    if (hit) fired.push({ id: rule.id, label: rule.label, priority: rule.priority, reason });
  }

  return fired;
}

const PRIORITY_ORDER: Record<SalesTask["priority"], number> = { LOW: 0, NORMAL: 1, HIGH: 2, URGENT: 3 };

/**
 * Create a sales task if one is warranted and none is already open.
 *
 * Idempotency matters here: a chatty customer produces an insight per message,
 * and without this check a single conversation would generate a dozen identical
 * "call this person" tasks. An existing open task is *upgraded* in priority
 * rather than duplicated.
 */
export function maybeCreateSalesTask(ctx: TriggerContext): SalesTask | null {
  const fired = evaluateTriggers(ctx);
  if (!fired.length) return null;

  const top = fired.sort((a, b) => PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority])[0];
  const db = read();
  const open = db.salesTasks.find(
    (t) => t.customerId === ctx.customer.id && (t.status === "OPEN" || t.status === "IN_PROGRESS"),
  );

  if (open) {
    if (PRIORITY_ORDER[top.priority] > PRIORITY_ORDER[open.priority]) {
      mutate((d) => {
        const t = d.salesTasks.find((x) => x.id === open.id);
        if (!t) return;
        t.priority = top.priority;
        t.reason = `${t.reason}; ${top.reason}`;
        t.notes.push(`Priority raised to ${top.priority}: ${top.reason}`);
      });
      audit({
        orgId: ctx.customer.orgId,
        actorType: "ai",
        action: "sales_task.priority_raised",
        entity: "sales_task",
        entityId: open.id,
        customerId: ctx.customer.id,
        metadata: { to: top.priority, trigger: top.id },
      });
    }
    return open;
  }

  const cfg = getConfig(ctx.customer.orgId);
  const now = new Date();
  const task: SalesTask = {
    id: uid("stk"),
    orgId: ctx.customer.orgId,
    customerId: ctx.customer.id,
    assignedToId: ctx.customer.assignedSalesManagerId,
    priority: top.priority,
    reason: top.reason,
    triggerId: top.id,
    aiSummary: buildBriefing(ctx.customer.id).text,
    sentiment: ctx.customer.sentiment,
    leadScore: ctx.customer.leadScore,
    objections: ctx.insight?.objections ?? [],
    requirements: Object.entries(ctx.customer.preferences).map(([k, v]) => `${k}: ${v}`),
    conversationSummary: ctx.insight?.summary ?? "",
    status: "OPEN",
    dueAt: new Date(now.getTime() + cfg.sla.salesCallHours * 3600_000).toISOString(),
    createdAt: now.toISOString(),
    notes: [],
  };

  mutate((d) => void d.salesTasks.push(task));
  audit({
    orgId: task.orgId,
    actorType: "ai",
    action: "sales_task.created",
    entity: "sales_task",
    entityId: task.id,
    customerId: task.customerId,
    metadata: { trigger: top.id, priority: top.priority, reason: top.reason },
  });

  // Assign only if nobody owns the customer yet — re-running the trigger must
  // not bounce an active lead to a different manager.
  if (!ctx.customer.assignedSalesManagerId) {
    assign({
      orgId: task.orgId,
      customerId: task.customerId,
      queue: "SALES",
      reason: top.reason,
      actorType: "system",
    });
  } else {
    notify({
      orgId: task.orgId,
      recipientId: ctx.customer.assignedSalesManagerId,
      category: "SALES",
      event: "sales_task.created",
      title: `${top.priority} — ${ctx.customer.name}`,
      body: top.reason,
      customerId: task.customerId,
      severity: top.priority === "URGENT" ? "CRITICAL" : "INFO",
    });
  }

  setStage(task.customerId, "QUALIFIED", { type: "ai" }, top.reason);
  return task;
}

/* -------------------------------------------------------------------------- */
/* Briefing                                                                    */
/* -------------------------------------------------------------------------- */

export interface Briefing {
  text: string;
  fields: Record<string, string>;
  recommendedAction: string;
}

/**
 * The pre-call briefing. Assembled from stored structured state, not by asking
 * a model to re-read the transcript — a sales manager should be able to trust
 * that "Budget: ₹5–7 Cr" came from something the customer actually said.
 */
export function buildBriefing(customerId: string): Briefing {
  const db = read();
  const customer = db.customers.find((c) => c.id === customerId);
  if (!customer) return { text: "Customer not found.", fields: {}, recommendedAction: "" };

  const insights = db.conversationInsights
    .filter((i) => i.customerId === customerId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const latest = insights[insights.length - 1];
  const messages = db.opsMessages.filter((m) => m.customerId === customerId);
  const lastInbound = [...messages].reverse().find((m) => m.direction === "inbound");

  const objections = [...new Set(insights.flatMap((i) => i.objections))];
  const questions = [...new Set(insights.flatMap((i) => i.questions))].slice(-4);
  const facts = insights.reduce<Record<string, string>>((a, i) => ({ ...a, ...i.facts }), {});
  const trend = sentimentTrend(customerId);

  const fields: Record<string, string> = {
    Intent: customer.intent,
    Sentiment: `${customer.sentiment} (${Math.round(customer.sentimentConfidence * 100)}% confidence, trend ${trend})`,
    "Lead Score": String(customer.leadScore),
    "Interested In": facts.interest ?? customer.purchaseInfo ?? "Not stated",
    Budget:
      customer.budgetMin && customer.budgetMax
        ? `${customer.budgetMin} – ${customer.budgetMax}`
        : (facts.budget ?? "Not stated"),
    "Financing Required": customer.loanRequired,
    "Main Concerns": objections.length ? objections.join("; ") : "None recorded",
    "Important Questions": questions.length ? questions.join(" | ") : "None recorded",
    "Last Conversation": lastInbound
      ? `${new Date(lastInbound.createdAt).toLocaleString()} — "${lastInbound.body.slice(0, 120)}"`
      : "No inbound messages",
  };

  const recommendedAction = recommendAction(customer, latest);
  fields["Recommended Next Action"] = recommendedAction;

  const text = ["CUSTOMER SUMMARY", ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`)].join("\n");
  return { text, fields, recommendedAction };
}

function recommendAction(customer: Customer, latest?: ConversationInsight): string {
  if (customer.intent === "NOT_INTERESTED") return "Confirm disinterest and close the lead, or offer to follow up later.";
  if (latest?.requestedHuman) return "Call now — the customer explicitly asked to speak to someone.";
  if (["NEGATIVE", "VERY_NEGATIVE"].includes(customer.sentiment)) return "Call to recover the relationship before discussing commercials.";
  if (customer.loanRequired === "YES") return "Confirm financing needs and hand to the loan department.";
  if (latest?.financingInterest) return "Discuss financing options and establish whether a loan is required.";
  if (customer.intent === "READY_TO_PROCEED") return "Call to confirm the unit and move to paperwork.";
  if (customer.intent === "HIGH_INTENT") return "Call to qualify budget and timeline, and offer a site visit.";
  return "Call to qualify requirements and establish budget.";
}

/* -------------------------------------------------------------------------- */
/* Task lifecycle                                                              */
/* -------------------------------------------------------------------------- */

export function updateSalesTask(
  taskId: string,
  patch: { status?: SalesTaskStatus; note?: string; assignedToId?: string },
  actor: { id?: string; type: "human" | "ai" | "system" },
): SalesTask | null {
  const now = new Date().toISOString();
  const task = mutate((db) => {
    const t = db.salesTasks.find((x) => x.id === taskId);
    if (!t) return null;
    if (patch.status) {
      t.status = patch.status;
      if (patch.status === "COMPLETED") t.completedAt = now;
    }
    if (patch.note) t.notes.push(patch.note);
    if (patch.assignedToId) t.assignedToId = patch.assignedToId;
    return { ...t };
  });
  if (!task) return null;

  audit({
    orgId: task.orgId,
    actorId: actor.id,
    actorType: actor.type,
    action: "sales_task.updated",
    entity: "sales_task",
    entityId: taskId,
    customerId: task.customerId,
    metadata: { ...patch },
  });
  return task;
}

/** Everything a sales workspace needs for one manager, in one pass. */
export function salesWorkspace(orgId: string, memberId?: string) {
  const db = read();
  const mine = db.customers.filter(
    (c) => c.orgId === orgId && (!memberId || c.assignedSalesManagerId === memberId),
  );
  const ids = new Set(mine.map((c) => c.id));
  const tasks = db.salesTasks.filter((t) => t.orgId === orgId && ids.has(t.customerId));
  const now = Date.now();

  return {
    myLeads: mine,
    newLeads: mine.filter((c) => c.leadStage === "NEW"),
    hotLeads: mine.filter((c) => c.leadScore > getConfig(orgId).scoring.bands.warm),
    callsPending: tasks.filter((t) => t.status === "OPEN" || t.status === "IN_PROGRESS"),
    callsCompleted: tasks.filter((t) => t.status === "COMPLETED"),
    followUpsDue: db.followUps.filter(
      (f) => ids.has(f.customerId) && f.lane === "SALES" && f.status === "SCHEDULED" && new Date(f.scheduledAt).getTime() <= now,
    ),
    customersWaiting: mine.filter((c) => c.salesControl === "HUMAN_CONTROL"),
    loanRequired: mine.filter((c) => c.loanRequired === "YES"),
    overdueTasks: tasks.filter((t) => t.status !== "COMPLETED" && t.status !== "CANCELLED" && new Date(t.dueAt).getTime() < now),
  };
}

export { getCustomer };
