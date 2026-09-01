import { mutate, read } from "../db";
import { uid } from "../ids";
import { complete, extractJson, hasLLM } from "../ai/provider";
import { audit } from "./audit";
import {
  BUYING_READINESS, ENGAGEMENT, INTENTS, SENTIMENTS, SENTIMENT_VALUE, URGENCY,
  type BuyingReadiness, type ConversationInsight, type Engagement, type Intent,
  type Sentiment, type SentimentEvent, type SentimentTrend, type Urgency,
} from "./types";

/**
 * CONVERSATION INTELLIGENCE
 *
 * Turns raw WhatsApp messages into structured CRM state. Three guarantees:
 *
 *  1. **Closed vocabularies.** Everything the model returns is validated against
 *     the enum before it is stored. An unrecognised label is coerced to the
 *     safest neighbour rather than persisted, so no downstream filter or
 *     threshold ever meets a string it does not understand.
 *  2. **Raw is preserved.** Extraction never replaces the messages it read.
 *  3. **Works without a model.** The deterministic extractor below is a real
 *     fallback, not a stub — the pipeline degrades in quality, never in
 *     function, when no API key is configured.
 *
 * Sentiment is advisory. It feeds scoring and escalation *proposals*; it never
 * moves a loan status or closes a deal on its own.
 */

/* -------------------------------------------------------------------------- */
/* Validation — never trust raw model output                                   */
/* -------------------------------------------------------------------------- */

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const v = String(value ?? "").toUpperCase().replace(/[\s-]+/g, "_");
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function asStringArray(value: unknown, max = 8): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x) => typeof x === "string" && x.trim()).slice(0, max).map((s) => String(s).slice(0, 200));
}

function clamp01(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
}

/* -------------------------------------------------------------------------- */
/* Deterministic extractor                                                     */
/* -------------------------------------------------------------------------- */

const PATTERNS = {
  pricing: /\b(price|pricing|cost|how much|rate|emi|instal?ment)\b/i,
  availability: /\b(available|availability|possession|ready to move|inventory)\b/i,
  visit: /\b(site visit|visit|viewing|walk ?through|see it|show me around)\b/i,
  financing: /\b(loan|finance|financing|mortgage|bank|emi|down payment|interest rate)\b/i,
  human: /\b(call me|speak to|talk to (a|someone)|human|agent|manager|representative|phone me)\b/i,
  negative: /\b(disappointed|frustrat|angry|unacceptable|terrible|worst|waste of time|ridiculous|annoyed|fed up)\b/i,
  positive: /\b(great|perfect|excellent|love|amazing|beautiful|interested|looks good|impressed)\b/i,
  ready: /\b(ready to (book|buy|proceed)|let'?s proceed|go ahead|book it|send the (agreement|paperwork))\b/i,
  notInterested: /\b(not interested|no longer|stop (contacting|messaging)|remove me|unsubscribe)\b/i,
  urgent: /\b(urgent|asap|immediately|today|right away|as soon as possible)\b/i,
  cannotProvide: /\b(don'?t have|do not have|can'?t provide|cannot provide|unable to (get|provide)|not available with me)\b/i,
  promise: /\b(i'?ll send|i will send|will share|send it (tonight|tomorrow|later|today)|by (tonight|tomorrow|evening))\b/i,
  dispute: /\b(why do you need|is that (really )?necessary|don'?t see why|already (sent|gave)|not required)\b/i,
  approval: /\b(will (i|it) (get|be) approved|approval chance|am i eligible|qualify for)\b/i,
};

export interface ExtractionInput {
  customerId: string;
  orgId: string;
  /** Newest last. */
  messages: Array<{ direction: "inbound" | "outbound"; body: string; createdAt: string }>;
}

/** Rule-based extraction. Used as the fallback and as a sanity floor. */
export function deterministicExtract(input: ExtractionInput): Omit<ConversationInsight, "id" | "createdAt"> {
  const inbound = input.messages.filter((m) => m.direction === "inbound");
  const text = inbound.map((m) => m.body).join("\n");

  const buyingSignals: string[] = [];
  if (PATTERNS.pricing.test(text)) buyingSignals.push("Asked about pricing");
  if (PATTERNS.availability.test(text)) buyingSignals.push("Asked about availability");
  if (PATTERNS.visit.test(text)) buyingSignals.push("Requested a site visit");
  if (PATTERNS.ready.test(text)) buyingSignals.push("Stated readiness to proceed");

  const objections: string[] = [];
  if (PATTERNS.dispute.test(text)) objections.push("Questioned a requirement");
  if (PATTERNS.cannotProvide.test(text)) objections.push("Says a document is unavailable");

  const questions = inbound
    .map((m) => m.body.trim())
    .filter((b) => b.includes("?"))
    .slice(-5);

  const requestedHuman = PATTERNS.human.test(text);
  const financingInterest = PATTERNS.financing.test(text);

  let intent: Intent = "INFORMATIONAL";
  if (PATTERNS.notInterested.test(text)) intent = "NOT_INTERESTED";
  else if (requestedHuman) intent = "HUMAN_HELP_REQUIRED";
  else if (PATTERNS.ready.test(text)) intent = "READY_TO_PROCEED";
  else if (PATTERNS.visit.test(text) || PATTERNS.availability.test(text)) intent = "HIGH_INTENT";
  else if (financingInterest) intent = "FINANCING_CONCERN";
  else if (PATTERNS.pricing.test(text)) intent = "INTERESTED";
  else if (inbound.length > 1) intent = "EXPLORING";

  const neg = PATTERNS.negative.test(text);
  const pos = PATTERNS.positive.test(text);
  const sentiment: Sentiment = neg && !pos ? "NEGATIVE" : pos && !neg ? "POSITIVE" : neg && pos ? "UNCERTAIN" : "NEUTRAL";

  const facts: Record<string, string> = {};
  const budget = text.match(/\b(?:budget|around|upto|up to|under)\s*(?:is\s*)?([₹$€£]?\s?[\d.,]+\s*(?:cr|crore|lakh|l|k|m|million)?)/i);
  if (budget) facts.budget = budget[1].trim();
  const timeline = text.match(/\b(this month|next month|in \d+ (?:weeks?|months?)|by \w+)\b/i);
  if (timeline) facts.timeline = timeline[1];

  return {
    orgId: input.orgId,
    customerId: input.customerId,
    intent,
    sentiment,
    buyingSignals,
    objections,
    questions,
    financingInterest,
    requestedHuman,
    requiredFollowUp: PATTERNS.promise.test(text) ? "Customer promised to send something" : undefined,
    facts,
    summary:
      inbound.length === 0
        ? "No inbound messages yet."
        : `${inbound.length} inbound message(s). Intent ${intent}, sentiment ${sentiment}.` +
          (buyingSignals.length ? ` Signals: ${buyingSignals.join(", ")}.` : ""),
    deterministic: true,
  };
}

/* -------------------------------------------------------------------------- */
/* LLM extraction                                                              */
/* -------------------------------------------------------------------------- */

const SYSTEM = `You extract structured CRM data from customer conversations.
Return ONLY JSON. Never invent facts the customer did not state.
Use exactly these enums:
intent: ${INTENTS.join(" | ")}
sentiment: ${SENTIMENTS.join(" | ")}
urgency: ${URGENCY.join(" | ")}
engagement: ${ENGAGEMENT.join(" | ")}
buyingReadiness: ${BUYING_READINESS.join(" | ")}
If unsure, choose the more conservative value. Never guess a budget or a name.`;

export async function extractInsight(input: ExtractionInput): Promise<ConversationInsight> {
  const deterministic = deterministicExtract(input);
  let merged = deterministic;

  if (hasLLM() && input.messages.length > 0) {
    const transcript = input.messages
      .slice(-25)
      .map((m) => `${m.direction === "inbound" ? "CUSTOMER" : "US"}: ${m.body}`)
      .join("\n");

    const raw = await complete({
      system: SYSTEM,
      prompt: `Conversation:\n${transcript}\n\nReturn JSON:
{"intent":"","sentiment":"","confidence":0.0,"urgency":"","engagement":"","buyingReadiness":"",
"buyingSignals":[],"objections":[],"concerns":[],"positiveSignals":[],"negativeSignals":[],
"questions":[],"financingInterest":false,"requestedHuman":false,"requiredFollowUp":null,
"facts":{},"summary":""}`,
      maxTokens: 1200,
      temperature: 0.2,
    });

    const parsed = extractJson<Record<string, unknown>>(raw);
    if (parsed) {
      // Every field is validated against the enum before it is trusted.
      merged = {
        ...deterministic,
        intent: asEnum<Intent>(parsed.intent, INTENTS, deterministic.intent),
        sentiment: asEnum<Sentiment>(parsed.sentiment, SENTIMENTS, deterministic.sentiment),
        buyingSignals: asStringArray(parsed.buyingSignals).length ? asStringArray(parsed.buyingSignals) : deterministic.buyingSignals,
        objections: asStringArray(parsed.objections),
        questions: asStringArray(parsed.questions).length ? asStringArray(parsed.questions) : deterministic.questions,
        // Boolean signals OR with the rule-based read: the regex catching an
        // explicit "call me" must not be overridden by a model that missed it.
        financingInterest: Boolean(parsed.financingInterest) || deterministic.financingInterest,
        requestedHuman: Boolean(parsed.requestedHuman) || deterministic.requestedHuman,
        requiredFollowUp: typeof parsed.requiredFollowUp === "string" ? parsed.requiredFollowUp : deterministic.requiredFollowUp,
        facts: { ...deterministic.facts, ...(typeof parsed.facts === "object" && parsed.facts ? (parsed.facts as Record<string, string>) : {}) },
        summary: typeof parsed.summary === "string" && parsed.summary ? parsed.summary : deterministic.summary,
        deterministic: false,
      };
    }
  }

  const insight: ConversationInsight = { ...merged, id: uid("ins"), createdAt: new Date().toISOString() };
  mutate((db) => void db.conversationInsights.push(insight));
  return insight;
}

/* -------------------------------------------------------------------------- */
/* Sentiment history                                                           */
/* -------------------------------------------------------------------------- */

export function recordSentiment(e: {
  orgId: string;
  customerId: string;
  sentiment: Sentiment;
  confidence: number;
  intent: Intent;
  urgency?: Urgency;
  engagement?: Engagement;
  buyingReadiness?: BuyingReadiness;
  objections?: string[];
  concerns?: string[];
  positiveSignals?: string[];
  negativeSignals?: string[];
  sourceMessageId?: string;
  reason: string;
}): SentimentEvent {
  const event: SentimentEvent = {
    id: uid("snt"),
    orgId: e.orgId,
    customerId: e.customerId,
    sentiment: asEnum<Sentiment>(e.sentiment, SENTIMENTS, "NEUTRAL"),
    confidence: clamp01(e.confidence),
    intent: asEnum<Intent>(e.intent, INTENTS, "INFORMATIONAL"),
    urgency: asEnum<Urgency>(e.urgency, URGENCY, "NONE"),
    engagement: asEnum<Engagement>(e.engagement, ENGAGEMENT, "LOW"),
    buyingReadiness: asEnum<BuyingReadiness>(e.buyingReadiness, BUYING_READINESS, "UNKNOWN"),
    objections: e.objections ?? [],
    concerns: e.concerns ?? [],
    positiveSignals: e.positiveSignals ?? [],
    negativeSignals: e.negativeSignals ?? [],
    sourceMessageId: e.sourceMessageId,
    reason: e.reason,
    createdAt: new Date().toISOString(),
  };

  mutate((db) => {
    db.sentimentEvents.push(event);
    const c = db.customers.find((x) => x.id === e.customerId);
    if (c) {
      c.sentiment = event.sentiment;
      c.sentimentConfidence = event.confidence;
      c.intent = event.intent;
      c.updatedAt = event.createdAt;
    }
  });

  audit({
    orgId: e.orgId,
    actorType: "ai",
    action: "sentiment.updated",
    entity: "customer",
    entityId: e.customerId,
    customerId: e.customerId,
    metadata: { sentiment: event.sentiment, intent: event.intent, confidence: event.confidence, reason: e.reason },
  });

  return event;
}

/** Direction of travel over the last few readings. */
export function sentimentTrend(customerId: string): SentimentTrend {
  const events = read()
    .sentimentEvents.filter((e) => e.customerId === customerId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (events.length < 2) return "UNKNOWN";

  const recent = events.slice(-4).map((e) => SENTIMENT_VALUE[e.sentiment]);
  const delta = recent[recent.length - 1] - recent[0];
  if (delta >= 0.75) return "IMPROVING";
  if (delta <= -0.75) return "DECLINING";
  return "STABLE";
}

export function sentimentTimeline(customerId: string): SentimentEvent[] {
  return read()
    .sentimentEvents.filter((e) => e.customerId === customerId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export { PATTERNS as INTENT_PATTERNS };
