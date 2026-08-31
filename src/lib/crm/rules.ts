import type { CrmContact, CrmTask, Lead, TaskType } from "./types";

/**
 * FOLLOW-UP RULES ENGINE
 *
 * In a ₹1.2–25 Cr sale the deal is rarely lost on price; it is lost because a
 * site visit was never confirmed, a post-visit call never happened, or an
 * agreement deadline slipped past. Those obligations are *implied by state*, so
 * generating them beats asking a salesperson to remember.
 *
 * Two properties make this safe to run on every page load and on a cron:
 *  - **Deterministic ids.** Each rule produces `auto_{ruleId}_{leadId}`, so
 *    re-running never duplicates a task, and a task a person completed is not
 *    resurrected (completed tasks keep the id and block regeneration).
 *  - **No side effects here.** `evaluate()` is pure and returns what *should*
 *    exist; the caller diffs it against what does. That makes it testable and
 *    means a bug can't silently spam someone's task list.
 */

const DAY = 86400000;

export interface RuleContext {
  leads: Lead[];
  contacts: CrmContact[];
  existing: CrmTask[];
  now: number;
}

export interface RuleDef {
  id: string;
  label: string;
  /** Why this rule exists, surfaced in the UI next to the generated task. */
  why: string;
}

export const RULES: RuleDef[] = [
  { id: "first_response", label: "First response within 24h", why: "Enquiries answered within a day convert far better than ones answered later; after 24 hours a portal lead has usually spoken to three other developers." },
  { id: "site_visit_confirm", label: "Confirm site visit 24h before", why: "Unconfirmed site visits are the single largest source of no-shows." },
  { id: "post_visit_call", label: "Post-visit feedback call", why: "The 24 hours after a visit is when objections are still specific and answerable." },
  { id: "negotiation_nudge", label: "Negotiation follow-up every 3 days", why: "A negotiation that goes quiet for a week is usually a negotiation with someone else." },
  { id: "agreement_draft", label: "Draft agreement 7 days after token", why: "Token receipts normally commit the buyer to execute an agreement within a set window." },
  { id: "agreement_sign", label: "Agreement signing at 21 days", why: "Stamp duty and registration timelines run from the agreement date, so slipping it moves every downstream deadline." },
  { id: "registration", label: "Registration at 45 days", why: "Registration completes the transfer; delays expose both sides to statutory penalties." },
  { id: "kyc_chase", label: "Chase KYC after 7 days pending", why: "Payments and registration both stall on incomplete KYC — it is the most common silent blocker." },
  { id: "reengage", label: "Re-engage after 7 quiet days", why: "A contacted lead with no activity for a week is going cold while still counted as active in the pipeline." },
];

export const RULE_BY_ID = Object.fromEntries(RULES.map((r) => [r.id, r]));

interface Draft {
  ruleId: string;
  leadId?: string;
  contactId?: string;
  title: string;
  type: TaskType;
  dueAt: number;
  priority: CrmTask["priority"];
  assignedTo: string;
}

/** Pure: returns the tasks that *should* exist given current state. */
export function evaluate(ctx: RuleContext): Draft[] {
  const out: Draft[] = [];
  const push = (d: Draft) => out.push(d);

  for (const lead of ctx.leads) {
    if (lead.status === "lost" || lead.status === "won") continue;
    const owner = lead.assignedTo;

    if (lead.status === "new" && !lead.lastContactedAt) {
      push({
        ruleId: "first_response",
        leadId: lead.id,
        title: `First call — ${lead.name}`,
        type: "call",
        dueAt: new Date(lead.createdAt).getTime() + DAY,
        priority: "high",
        assignedTo: owner,
      });
    }

    if (lead.siteVisitAt) {
      const visit = new Date(lead.siteVisitAt).getTime();
      if (visit > ctx.now) {
        push({
          ruleId: "site_visit_confirm",
          leadId: lead.id,
          title: `Confirm site visit — ${lead.name}`,
          type: "site_visit",
          dueAt: visit - DAY,
          priority: "high",
          assignedTo: owner,
        });
      } else if (ctx.now - visit < 7 * DAY) {
        // Only for a *recent* visit. Raising "post-visit feedback" on a walkthrough
        // from three months ago is noise, and noise is how a reminder list dies.
        push({
          ruleId: "post_visit_call",
          leadId: lead.id,
          title: `Post-visit feedback — ${lead.name}`,
          type: "call",
          dueAt: visit + DAY,
          priority: "high",
          assignedTo: owner,
        });
      }
    }

    if (lead.status === "negotiation") {
      const anchor = new Date(lead.lastContactedAt ?? lead.updatedAt).getTime();
      push({
        ruleId: "negotiation_nudge",
        leadId: lead.id,
        title: `Negotiation follow-up — ${lead.name}`,
        type: "call",
        dueAt: anchor + 3 * DAY,
        priority: "high",
        assignedTo: owner,
      });
    }

    if (lead.tokenPaidAt) {
      const token = new Date(lead.tokenPaidAt).getTime();
      push({
        ruleId: "agreement_draft",
        leadId: lead.id,
        title: `Draft agreement — ${lead.name}`,
        type: "document",
        dueAt: token + 7 * DAY,
        priority: "high",
        assignedTo: owner,
      });
      push({
        ruleId: "agreement_sign",
        leadId: lead.id,
        title: `Agreement signing — ${lead.name}`,
        type: "agreement",
        dueAt: token + 21 * DAY,
        priority: "high",
        assignedTo: owner,
      });
      push({
        ruleId: "registration",
        leadId: lead.id,
        title: `Registration — ${lead.name}`,
        type: "document",
        dueAt: token + 45 * DAY,
        priority: "normal",
        assignedTo: owner,
      });
    }

    if (lead.kycStatus === "pending") {
      push({
        ruleId: "kyc_chase",
        leadId: lead.id,
        title: `Chase KYC documents — ${lead.name}`,
        type: "document",
        dueAt: new Date(lead.updatedAt).getTime() + 7 * DAY,
        priority: "normal",
        assignedTo: owner,
      });
    }

    if (lead.status === "contacted" && lead.lastContactedAt) {
      const quiet = ctx.now - new Date(lead.lastContactedAt).getTime();
      if (quiet > 7 * DAY) {
        push({
          ruleId: "reengage",
          leadId: lead.id,
          title: `Re-engage — ${lead.name}`,
          type: "whatsapp",
          dueAt: ctx.now,
          priority: "normal",
          assignedTo: owner,
        });
      }
    }
  }

  return out;
}

/** Stable id so regeneration is idempotent. */
export function taskId(ruleId: string, leadId?: string, contactId?: string): string {
  return `auto_${ruleId}_${leadId ?? contactId ?? "x"}`;
}

/**
 * Diff drafts against existing tasks. A task the user completed or snoozed keeps
 * its id and is *not* recreated — regenerating a task someone deliberately
 * closed is the fastest way to make people ignore the whole list.
 */
export function diff(drafts: Draft[], existing: CrmTask[], brandId: string): CrmTask[] {
  const known = new Set(existing.map((t) => t.id));
  const now = new Date().toISOString();
  return drafts
    .filter((d) => !known.has(taskId(d.ruleId, d.leadId, d.contactId)))
    .map((d) => ({
      id: taskId(d.ruleId, d.leadId, d.contactId),
      brandId,
      title: d.title,
      type: d.type,
      dueAt: new Date(d.dueAt).toISOString(),
      status: "open" as const,
      assignedTo: d.assignedTo,
      leadId: d.leadId,
      contactId: d.contactId,
      priority: d.priority,
      autoGenerated: true,
      rule: d.ruleId,
      notes: RULE_BY_ID[d.ruleId]?.why,
      createdAt: now,
    }));
}

/**
 * LEAD SCORE (0–100).
 *
 * Weighted on what actually predicts a close in this market: how far the lead
 * has moved, how much money is on the table, how warm the channel is, and how
 * recently anyone spoke to them. Recency is a *penalty* rather than a bonus, so
 * a fat stale lead cannot outrank a live one.
 */
export function scoreLead(lead: Lead, now = Date.now()): number {
  const stageWeight: Record<Lead["status"], number> = {
    new: 5,
    contacted: 15,
    site_visit_scheduled: 35,
    negotiation: 50,
    booking_token_paid: 75,
    won: 100,
    lost: 0,
  };

  let score = stageWeight[lead.status];

  // Budget: a ₹25 Cr enquiry deserves attention a ₹1.2 Cr one does not command.
  const budget = (lead.budgetMin + lead.budgetMax) / 2;
  score += Math.min(15, (budget / 2.5e8) * 15);

  // Channel quality: a referral or broker intro converts far better than a portal.
  const sourceBonus: Partial<Record<Lead["source"], number>> = {
    referral: 12,
    broker: 9,
    walk_in: 9,
    whatsapp: 6,
    website: 5,
    instagram: 3,
    facebook: 3,
    meta_ads: 3,
    google_ads: 4,
    portal_99acres: 2,
    portal_magicbricks: 2,
    portal_housing: 2,
  };
  score += sourceBonus[lead.source] ?? 0;

  if (lead.isHNWI) score += 6;
  if (lead.kycStatus === "verified") score += 5;

  // Staleness penalty, capped so an old lead never scores negative on its own.
  const quietDays = lead.lastContactedAt ? (now - new Date(lead.lastContactedAt).getTime()) / DAY : 14;
  score -= Math.min(20, quietDays * 1.5);

  return Math.max(0, Math.min(100, Math.round(score)));
}
