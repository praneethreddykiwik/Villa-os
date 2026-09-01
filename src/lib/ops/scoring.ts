import { mutate, read } from "../db";
import { uid } from "../ids";
import { getConfig } from "./config";
import type { ConversationInsight, Customer, ScoreEvent, Sentiment } from "./types";

/**
 * LEAD SCORING — deterministic and fully auditable.
 *
 * The LLM never picks the number. It only reports *observations* ("the customer
 * asked about pricing"), and those observations map onto configured weights
 * here. Two reasons this matters:
 *
 *  1. A model asked for "a score out of 100" gives a different answer on the
 *     same input twice, which makes thresholds, routing and reporting unusable.
 *  2. Sales teams reasonably ask "why is this lead an 82?" — every point is
 *     traceable to a named signal and its configured weight.
 */

export interface SignalSet {
  askedPricing?: boolean;
  askedAvailability?: boolean;
  requestedVisit?: boolean;
  askedFinancing?: boolean;
  providedBudget?: boolean;
  providedDetails?: boolean;
  requestedHuman?: boolean;
  fastResponse?: boolean;
  repeatEngagement?: boolean;
  documentsReady?: boolean;
  nearTermTimeline?: boolean;
  sentiment?: Sentiment;
  notInterested?: boolean;
  daysSinceContact?: number;
}

const SIGNAL_KEY: Record<string, keyof SignalSet> = {
  asked_pricing: "askedPricing",
  asked_availability: "askedAvailability",
  requested_visit: "requestedVisit",
  asked_financing: "askedFinancing",
  provided_budget: "providedBudget",
  provided_details: "providedDetails",
  requested_human: "requestedHuman",
  fast_response: "fastResponse",
  repeat_engagement: "repeatEngagement",
  documents_ready: "documentsReady",
  near_term_timeline: "nearTermTimeline",
};

export interface ScoreResult {
  score: number;
  band: ScoreEvent["band"];
  contributions: ScoreEvent["contributions"];
}

export function computeScore(orgId: string, signals: SignalSet): ScoreResult {
  const cfg = getConfig(orgId);
  const contributions: ScoreEvent["contributions"] = [];
  let raw = 0;

  for (const rule of cfg.scoring.rules) {
    if (!rule.enabled) continue;

    let hit = false;
    let reason = "";

    const key = SIGNAL_KEY[rule.signal];
    if (key) {
      hit = Boolean(signals[key]);
      reason = rule.label;
    } else if (rule.signal === "positive_sentiment") {
      hit = signals.sentiment === "POSITIVE" || signals.sentiment === "VERY_POSITIVE";
      reason = `Sentiment is ${signals.sentiment}`;
    } else if (rule.signal === "negative_sentiment") {
      hit = signals.sentiment === "NEGATIVE" || signals.sentiment === "VERY_NEGATIVE";
      reason = `Sentiment is ${signals.sentiment}`;
    } else if (rule.signal === "not_interested") {
      hit = Boolean(signals.notInterested);
      reason = "Customer stated they are not interested";
    } else if (rule.signal === "stale") {
      hit = (signals.daysSinceContact ?? 0) >= 7;
      reason = `No contact for ${Math.round(signals.daysSinceContact ?? 0)} days`;
    }

    if (hit) {
      raw += rule.points;
      contributions.push({ signal: rule.signal, points: rule.points, reason });
    }
  }

  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const { cold, warm, hot } = cfg.scoring.bands;
  const band: ScoreEvent["band"] = score <= cold ? "COLD" : score <= warm ? "WARM" : score <= hot ? "HOT" : "VERY_HOT";

  return { score, band, contributions };
}

/** Derive the signal set from stored state — no model call required. */
export function signalsForCustomer(customerId: string): SignalSet {
  const db = read();
  const customer = db.customers.find((c) => c.id === customerId);
  if (!customer) return {};

  const insights = db.conversationInsights.filter((i) => i.customerId === customerId);
  const messages = db.opsMessages.filter((m) => m.customerId === customerId);
  const inbound = messages.filter((m) => m.direction === "inbound");
  const documents = db.documents.filter((d) => d.customerId === customerId);

  const text = insights
    .flatMap((i) => [...i.questions, ...i.buyingSignals, i.summary])
    .join(" ")
    .toLowerCase();

  // Median inbound reply gap — "fast" means engaged, not merely awake.
  const gaps: number[] = [];
  for (let i = 1; i < inbound.length; i++) {
    gaps.push(new Date(inbound[i].createdAt).getTime() - new Date(inbound[i - 1].createdAt).getTime());
  }
  const medianGap = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : Infinity;

  const last = customer.lastInteractionAt ? new Date(customer.lastInteractionAt).getTime() : undefined;

  return {
    askedPricing: /price|pricing|cost|rate|how much/.test(text),
    askedAvailability: /available|availability|inventory|units? left|possession/.test(text),
    requestedVisit: /site visit|visit|viewing|walkthrough|see the/.test(text),
    askedFinancing: insights.some((i) => i.financingInterest),
    providedBudget: customer.budgetMin !== undefined || /budget/.test(text),
    providedDetails: Boolean(customer.email) || Object.keys(customer.preferences).length > 0,
    requestedHuman: insights.some((i) => i.requestedHuman),
    fastResponse: medianGap < 30 * 60 * 1000,
    repeatEngagement: inbound.length >= 4,
    documentsReady: documents.length > 0,
    nearTermTimeline: /this month|next month|immediately|urgent|asap|ready to/.test(text),
    sentiment: customer.sentiment,
    notInterested: customer.intent === "NOT_INTERESTED",
    daysSinceContact: last ? (Date.now() - last) / 86400000 : undefined,
  };
}

/**
 * Recompute and persist. Writes a ScoreEvent only when the number actually
 * changes, so the history stays a record of movement rather than a log of ticks.
 */
export function rescoreCustomer(customerId: string, extra: SignalSet = {}): ScoreResult | null {
  const db = read();
  const customer = db.customers.find((c) => c.id === customerId);
  if (!customer) return null;

  const result = computeScore(customer.orgId, { ...signalsForCustomer(customerId), ...extra });
  if (result.score === customer.leadScore) return result;

  mutate((d) => {
    const c = d.customers.find((x) => x.id === customerId);
    if (!c) return;
    const event: ScoreEvent = {
      id: uid("scr"),
      orgId: c.orgId,
      customerId,
      score: result.score,
      previousScore: c.leadScore,
      band: result.band,
      contributions: result.contributions,
      createdAt: new Date().toISOString(),
    };
    d.scoreEvents.push(event);
    c.leadScore = result.score;
    c.updatedAt = event.createdAt;
  });

  return result;
}

export function bandFor(orgId: string, score: number): ScoreEvent["band"] {
  const { cold, warm, hot } = getConfig(orgId).scoring.bands;
  return score <= cold ? "COLD" : score <= warm ? "WARM" : score <= hot ? "HOT" : "VERY_HOT";
}

/** Signals implied by a single freshly-extracted insight. */
export function signalsFromInsight(i: ConversationInsight, customer: Customer): SignalSet {
  return {
    askedFinancing: i.financingInterest,
    requestedHuman: i.requestedHuman,
    sentiment: i.sentiment,
    notInterested: i.intent === "NOT_INTERESTED",
    providedBudget: customer.budgetMin !== undefined,
  };
}
