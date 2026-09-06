import { createRequire } from "node:module";
import { complete, hasLLM, rateLimitedRecently } from "../ai/provider";
import { book, slots } from "../appointments/engine";
import { isUsableConnection } from "../platforms/registry";
import { mutate, read } from "../db";
import { uid } from "../ids";
import { sendWhatsApp, type InboundMedia, type WhatsAppInboundType } from "../platforms/whatsapp";
import type { Brand } from "../types";
import { audit } from "./audit";
import { sendDueReminders, type ReminderTickResult } from "../notify/reminders";
import { getConfig } from "./config";
import { automationAllowed, getCustomer, updateCustomer, upsertCustomer } from "./customers";
import { receiveDocument } from "./documents";
import { cancelFollowUps, createFollowUp, dueFollowUps, escalate, markSent, syncDocumentFollowUps } from "./followups";
import { deterministicExtract, extractInsight, INTENT_PATTERNS, recordSentiment } from "./intelligence";
import { ensureKnowledge, factsBlock, logGap, retrieve } from "./knowledge";
import { activeCase, caseProgress, checklistFor, createLoanCase, updateChecklistItem } from "./loan";
import { assign } from "./assignment";
import { notify } from "./audit";
import {
  callbackWindow, detectLanguage, deterministicReply, factsSentence, LANGUAGE_NAME, matchSlots, parseVisitPreference,
  routeIntent, topicForIntent, withNextStep, type Lang, type RoutedIntent, type VisitPreference,
} from "./router";
import { maybeCreateSalesTask } from "./sales";
import { rescoreCustomer } from "./scoring";
import { TOOLS } from "./tools";
import type { KbTopic, OpsMessage } from "./types";

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
 * Composition is deterministic and template-based first. For a system that
 * tells people what paperwork their loan needs, predictable phrasing bounded
 * by real state is worth more than fluency. The LLM (Groq, free tier) is
 * layered on top for the *sales conversation only*: it may rephrase and answer
 * from brand facts, it never speaks on approval, documents, price or law, and
 * every hard-bounded path below bypasses it entirely. One completion per
 * inbound message, and any failure falls back to the deterministic sentence —
 * the customer always gets an answer.
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
  /** What kind of message this was. Defaults to text. */
  type?: WhatsAppInboundType;
  /** Downloaded bytes for an image/document. Absent when the download failed. */
  media?: InboundMedia;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  /** Button/list reply — `id` is ours (e.g. "slot:<iso>"), `title` is what they tapped. */
  interactive?: { id?: string; title: string };
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
  /** Stored document for an inbound image/document. */
  documentId?: string;
  /** Delivery was refused by the 24h window; the reply is queued as a follow-up. */
  requiresTemplate?: boolean;
  /** Site visit created from an interactive/numbered slot reply. */
  appointmentId?: string;
  /** Which composition path answered — "media", "visit_slots", "clarify", "llm"… */
  replyTag?: string;
}

/** A reply plus the path that produced it, so the agent can read its own history. */
interface Composed {
  text: string;
  tag: string;
  meta?: Record<string, string>;
  escalationId?: string;
  appointmentId?: string;
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
 * Deliveries being handled right now, keyed by externalId. The stored-row check
 * above only sees rows already written, and a media message writes its row
 * after `await ingestMedia()` — a retry arriving in that window (Meta retries
 * un-acked webhooks while the route may spend up to 30s fetching media) would
 * otherwise be processed twice. Reserving synchronously, before the first
 * await, closes that gap within a process.
 */
const inFlight = new Map<string, Promise<AgentOutcome>>();

/**
 * Handle one inbound customer message end to end: persist, extract, score,
 * evaluate triggers, escalate if needed, and compose a grounded reply.
 */
export async function handleInbound(input: InboundMessage): Promise<AgentOutcome> {
  const key = input.externalId;
  if (alreadyProcessed(key)) {
    const existing = read().opsMessages.find((m) => m.externalId === key)!;
    return { customerId: existing.customerId, created: false, reply: null, silentReason: "duplicate webhook", duplicate: true };
  }
  if (!key) return processInbound(input);

  const running = inFlight.get(key);
  if (running) {
    // Let the first delivery finish so the caller learns which customer it was.
    const first = await running.catch(() => null);
    return { customerId: first?.customerId ?? "", created: false, reply: null, silentReason: "duplicate webhook", duplicate: true };
  }
  const job = processInbound(input).finally(() => void inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

async function processInbound(input: InboundMessage): Promise<AgentOutcome> {
  const { customer, created } = upsertCustomer({
    orgId: input.orgId,
    phone: input.phone,
    name: input.name,
    source: "whatsapp",
  });
  const kind: WhatsAppInboundType = input.type ?? "text";

  // Media first, so the message row can point at the stored document. Every
  // customer's file is kept — not only those with a loan case — because the
  // photo a buyer sends before financing starts is exactly the one the loan
  // officer will ask for later.
  const ingested = (kind === "image" || kind === "document") ? await ingestMedia(input.orgId, customer.id, input.media, kind) : null;
  const documentId = input.documentId ?? ingested?.documentId;

  const message = recordMessage({
    orgId: input.orgId,
    customerId: customer.id,
    channel: "whatsapp",
    direction: "inbound",
    body: input.body,
    documentId,
    authorType: "customer",
    externalId: input.externalId,
    createdAt: input.receivedAt,
  });

  updateCustomer(customer.id, { lastInteractionAt: message.createdAt }, { type: "system" });

  // A reaction to our own message or a Meta notification carries nothing the
  // customer said: recorded for idempotency, but no insight, no trigger and
  // above all no reply — asking "could you send that as text?" after a thumbs-up
  // reads as broken, and the outbound would burn cooldown and the daily cap.
  if (kind === "reaction" || kind === "system" || kind === "unsupported") {
    return { customerId: customer.id, created, reply: null, silentReason: `${kind} is not a customer message`, duplicate: false };
  }

  // Opt-out is an absolute stop, checked before anything else runs. Only the
  // customer's own words count — a document caption never reads as "stop".
  const spoken = kind === "text" || kind === "interactive" || kind === "button";
  if (spoken && OPT_OUT.test(input.body)) {
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
    // One confirmation, then silence: automationAllowed() blocks every later send
    // until the customer says START (see OPT_IN below) — the copy names the word
    // so the promise is one the agent can actually keep.
    const reply = "Understood — I won't send you any more automated messages. If you'd like to pick this up again, just reply START.";
    const sent = await deliver(input.orgId, customer.id, reply, "ai", undefined, { tag: "opt_out" });
    return { customerId: customer.id, created, reply, duplicate: false, requiresTemplate: sent.requiresTemplate, replyTag: "opt_out" };
  }

  // The opt-out confirmation promises that START re-engages, so honour it: an
  // explicit re-opt-in phrase clears the flag (with an audit trail) and the
  // message then flows through the normal pipeline and gets answered. Anything
  // else from an opted-out customer stays silent — "what is the price?" is not
  // consent to resume automation.
  if (spoken && customer.optedOut && OPT_IN.test(input.body)) {
    updateCustomer(customer.id, { optedOut: false }, { type: "system" });
    audit({
      orgId: input.orgId,
      actorType: "customer",
      action: "customer.opted_in",
      entity: "customer",
      entityId: customer.id,
      customerId: customer.id,
      metadata: { body: input.body.slice(0, 80) },
    });
  }

  if (kind === "location" && input.location) {
    // A shared pin is a durable fact about the buyer, kept where other facts live.
    const { latitude, longitude, name, address } = input.location;
    TOOLS.update_customer_profile(
      { orgId: input.orgId, customerId: customer.id, actorType: "ai" },
      { preferences: { sharedLocation: [name, address, `${latitude},${longitude}`].filter(Boolean).join(" · ").slice(0, 200) } },
    );
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
  // "I need a home loan" opens the file and starts the document chase.
  let caseOpened = false;
  if (kind === "text" && LOAN_NEEDED.test(input.body) && customer.loanRequired !== "NO" && !customer.optedOut && !activeCase(customer.id)) {
    caseOpened = openLoanCaseFromChat(input.orgId, customer.id).opened;
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
      documentId,
      duplicate: false,
    };
  }

  // A reply the 24h window blocked earlier is owed to the customer, but it
  // must land BEFORE this message's answer: if the cron tick sent it later it
  // would arrive out of order and, worse, become the newest outbound — so a
  // "1" after a slot offer would no longer match. Send it now, in order.
  await flushQueuedReplies(input.orgId, customer.id);

  const composed = await compose(customer.id, input, kind, ingested, Boolean(escalationId), caseOpened);
  escalationId = composed?.escalationId ?? escalationId;
  // Exactly one outbound per inbound. Idempotency on externalId above means a
  // webhook retry cannot produce a second one either.
  const sent = composed
    ? await deliver(input.orgId, customer.id, composed.text, "ai", undefined, { tag: composed.tag, meta: composed.meta })
    : undefined;

  return {
    customerId: customer.id,
    created,
    reply: composed?.text ?? null,
    insightId: insight.id,
    salesTaskId: task?.id,
    escalationId,
    documentId,
    duplicate: false,
    requiresTemplate: sent?.requiresTemplate,
    appointmentId: composed?.appointmentId,
    replyTag: composed?.tag,
  };
}

const OPT_OUT = /\b(stop|unsubscribe|do not (contact|message)|opt.?out)\b/i;
// Checked only after OPT_OUT, so "stop" always wins over "start" in one message.
const OPT_IN = /\b(start|resume|continue|unstop|opt.?in|subscribe)\b/i;

/* -------------------------------------------------------------------------- */
/* Media ingestion                                                             */
/* -------------------------------------------------------------------------- */

interface Ingested {
  documentId?: string;
  /** Checklist item the file was attributed to, if a loan case wanted one. */
  itemLabel?: string;
  duplicate: boolean;
  /** Why nothing was stored: not downloaded, unsupported type, storage error. */
  error?: string;
  /** Formats the item we were chasing accepts — so a refusal can say what to send instead. */
  acceptedFormats?: string[];
}

/**
 * Store an inbound file on the customer record. With an active loan case the
 * file is attributed to the item we most recently chased (a rejected item
 * first — that is what we asked for); without one it is simply kept on file
 * with no checklist link, for the officer to attach later.
 */
async function ingestMedia(
  orgId: string,
  customerId: string,
  media: InboundMedia | undefined,
  kind: "image" | "document",
): Promise<Ingested> {
  if (!media) return { duplicate: false, error: `${kind} could not be downloaded` };
  // Refused before download (too large) — nothing to store, but the reason matters.
  if (media.error) return { duplicate: false, error: media.error };
  const loanCase = activeCase(customerId);
  const target = loanCase ? (() => { const p = caseProgress(loanCase.id); return p.rejected[0] ?? p.missing[0]; })() : undefined;
  const stored = await receiveDocument({
    orgId,
    customerId,
    filename: media.filename,
    mimeType: media.mimeType,
    data: media.data,
    checklistItemId: target?.id,
    loanCaseId: loanCase?.id,
    uploadedBy: "customer",
  });
  if (!stored.ok) return { duplicate: false, error: stored.error, acceptedFormats: target?.acceptedFormats };
  return { documentId: stored.document.id, itemLabel: target?.customerLabel, duplicate: stored.duplicate };
}

/* -------------------------------------------------------------------------- */
/* Loan document chase                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The customer said they need financing — not merely mentioned a bank. "Do
 * you have EMI options?" is a question answered from the knowledge base; "I
 * need a home loan" opens the file.
 */
const LOAN_NEEDED = /\b(need|needs|want|wants|require|looking for|apply(?:ing)? for|help (?:me )?with|take|avail|get)\b[^.?!]{0,30}\b(home ?loan|loan|financing|finance|emi|mortgage)\b|\b(loan|financing|finance|emi)\b[^.?!]{0,20}\b(needed|required)\b/i;
/** "Which documents do you need?" — at any point, list what is still missing. */
const DOCS_QUESTION = /\b(which|what|list of|all the)\b[^.?!]{0,30}\b(documents?|papers|paperwork)\b|\b(documents?|papers|paperwork)\b[^.?!]{0,30}\b(need|needed|required|missing|pending|left|remaining)\b/i;

const MAX_LIST_LINES = 8;

/**
 * Open the loan file from conversation. The default document set is applied
 * by createLoanCase; here every item is marked REQUESTED (the customer is
 * about to be told) and the daily reminder starts tomorrow, not now — the
 * list itself is the day-0 message.
 */
function openLoanCaseFromChat(orgId: string, customerId: string): { loanCase: ReturnType<typeof activeCase>; opened: boolean } {
  const existing = activeCase(customerId);
  if (existing) return { loanCase: existing, opened: false };
  const { loanCase, created } = createLoanCase({ orgId, customerId, loanType: "home", actorType: "ai" });
  for (const i of checklistFor(loanCase.id).filter((x) => x.status === "NOT_REQUESTED")) {
    updateChecklistItem(i.id, { status: "REQUESTED" }, { type: "ai" });
  }
  scheduleDocumentReminder(loanCase.id);
  return { loanCase: activeCase(customerId) ?? loanCase, opened: created };
}

/** One gentle reminder a day for whatever is still missing, starting tomorrow. */
function scheduleDocumentReminder(loanCaseId: string): void {
  const loanCase = read().loanCases.find((l) => l.id === loanCaseId);
  if (!loanCase) return;
  if (!caseProgress(loanCaseId).missing.length) return;
  createFollowUp({
    orgId: loanCase.orgId,
    customerId: loanCase.customerId,
    kind: "DOCUMENT_REQUEST",
    lane: "LOAN",
    loanCaseId,
    reason: "Daily reminder for missing loan documents",
    scheduledAt: new Date(Date.now() + 86400_000).toISOString(),
  });
}

/** Numbered list of what is still needed — required items first, at most 8 lines. */
function documentListReply(customerId: string, greeting: string, opened: boolean): Composed {
  const loanCase = activeCase(customerId);
  const progress = loanCase ? caseProgress(loanCase.id) : undefined;
  if (!loanCase || !progress) return { text: `${greeting}our loan team will be in touch about financing shortly.`, tag: "loan" };
  const outstanding = [...progress.rejected, ...progress.missing];
  if (!outstanding.length) {
    return progress.awaitingReview.length || progress.allReceived
      ? { text: `${greeting}we have every document we asked for — our loan officer will review them and call you.`, tag: "loan" }
      : { text: `${greeting}there's nothing outstanding on your file right now.`, tag: "loan" };
  }
  const lines = outstanding.slice(0, MAX_LIST_LINES).map((i, n) => `${n + 1}. ${i.customerLabel}${i.status === "REJECTED" ? " (new copy)" : ""}`);
  const more = outstanding.length > MAX_LIST_LINES ? `\n…and ${outstanding.length - MAX_LIST_LINES} more once these are in.` : "";
  const lead = opened
    ? `${greeting}happy to help with the home loan. To get started, please send these documents here as photos or PDFs:`
    : `${greeting}here's what we still need from you:`;
  return { text: `${lead}\n${lines.join("\n")}${more}`, tag: opened ? "loan_opened" : "loan" };
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

/**
 * Pick the reply. Non-text kinds are acknowledged on their own bounded paths;
 * text goes through the deterministic composer and, for the open sales
 * conversation only, is then offered to the LLM for a grounded rephrase.
 */
async function compose(
  customerId: string,
  input: InboundMessage,
  kind: WhatsAppInboundType,
  ingested: Ingested | null,
  escalated: boolean,
  caseOpened = false,
): Promise<Composed | null> {
  const customer = getCustomer(customerId);
  if (!customer) return null;
  const first = customer.name.split(" ")[0];
  const greeting = customer.name === "Unknown" ? "" : `${first}, `;
  const ctx = { orgId: customer.orgId, customerId, actorType: "ai" as const };

  if (kind === "image" || kind === "document") return mediaReply(ctx, greeting, kind, ingested);

  if (kind === "audio") {
    // No transcription on the free tier — say so instead of guessing.
    return { text: `${greeting}thanks for the voice note. I can't listen to audio here, so could you type the main points? A colleague can also call you back if that's easier.`, tag: "audio" };
  }
  if (kind === "video" || kind === "sticker") {
    return { text: `${greeting}thanks for sending that. If there's something specific you'd like to know, just type it here.`, tag: "media_other" };
  }
  if (kind === "location") {
    return { text: `${greeting}thanks for sharing your location — I've noted it on your file. Would you like directions to the site, or shall we book a visit?`, tag: "location" };
  }
  if (kind === "unknown") {
    return { text: `${greeting}I couldn't read that message type. Could you send it as text, a photo or a PDF?`, tag: "clarify" };
  }

  // A tapped slot (button id "slot:<iso>") or a numbered reply to slots we
  // just offered books the visit directly.
  const chosen = chosenSlot(customerId, input);
  if (chosen) return bookVisit(customer, greeting, chosen);

  // Slot filling: "Saturday morning" after we offered times (or with the visit
  // request itself) narrows the offer to that day instead of re-listing the
  // next three. A day with no slots says so and offers the nearest instead.
  // Only for intents that plausibly refer to the visit — "call me tomorrow"
  // after an offer is a callback, not a refinement.
  const pref = parseVisitPreference(input.body);
  const routed = routeIntent(input.body);
  const refinable = routed === "visit" || routed === "greeting" || routed === "unknown";
  if (pref && refinable && (routed === "visit" || lastOfferWasSlots(customerId)) && !INTENT_PATTERNS.approval.test(input.body)) {
    return proposeVisit(customerId, greeting, pref, detectLanguage(input.body));
  }

  const draft = composeReply(customerId, input.body, escalated, { caseOpened });
  if (!draft) return null;
  if (!LLM_ELIGIBLE.has(draft.tag)) return draft;

  const polished = await llmReply(customer, input.body, draft);
  if (!polished) return draft;
  if (polished === "ESCALATE") {
    const brand = brandFor();
    if (brand) logGap({ brandId: brand.id, question: input.body, intent: draft.tag, customerId });
    const e = escalate({
      orgId: customer.orgId,
      customerId,
      ruleId: "ai_unknown",
      lane: "SALES",
      severity: "MEDIUM",
      reason: "Assistant could not answer from brand facts",
      detail: input.body.slice(0, 160),
    });
    return { text: `${greeting}that's one for a colleague — I've passed it on and someone will come back to you directly.`, tag: "handoff", escalationId: e?.id };
  }
  return { ...draft, text: polished, tag: "llm" };
}

/** Paths the LLM may rephrase. Everything else is bounded by real state. */
const LLM_ELIGIBLE = new Set(["sales", "clarify", "greeting", "pricing", "availability", "location", "amenities", "approvals", "payment", "documents"]);

/** Whether the newest agent-composed outbound was a slot offer (a day reply then refines it). */
function lastOfferWasSlots(customerId: string): boolean {
  const last = read()
    .opsMessages.filter((m) => m.customerId === customerId && m.direction === "outbound" && !m.automated)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return last?.tag === "visit_slots";
}

function mediaReply(ctx: { orgId: string; customerId: string; actorType: "ai" }, greeting: string, kind: "image" | "document", ingested: Ingested | null): Composed {
  const noun = kind === "image" ? "photo" : "document";
  if (!ingested?.documentId) {
    const unsupported = /unsupported|accepts/i.test(ingested?.error ?? "");
    // "Send it again" for an oversized file only invites the same file again.
    const tooLarge = /larger than/i.test(ingested?.error ?? "");
    const formats = (ingested?.acceptedFormats?.length ? ingested.acceptedFormats : ["pdf", "jpg", "png"]).map((f) => f.toUpperCase()).join(", ");
    return {
      text: unsupported
        ? `${greeting}I couldn't read that file. Please send it as ${formats} — a clear photo or a PDF works best.`
        : tooLarge
          ? `${greeting}that ${noun} is too large for me to accept (${ingested?.error}). Could you send a smaller or compressed version?`
          : `${greeting}I can see you sent a ${noun} but I couldn't retrieve it. Could you send it again?`,
      tag: "media_failed",
    };
  }
  if (ingested.duplicate) {
    return { text: `${greeting}looks like we already have that one — thanks, no need to resend.`, tag: "media" };
  }

  // Attributed to a checklist item: say what it was taken as, then what is
  // still needed. "Got"/"received", never "accepted" — no human has looked yet.
  if (ingested.itemLabel) {
    const missing = TOOLS.get_missing_documents(ctx);
    const still = missing.ok ? [...missing.data.rejected, ...missing.data.missing].map((i) => i.label) : [];
    if (still.length) {
      return { text: `${greeting}got your ${ingested.itemLabel}. Still needed: ${still.slice(0, 3).join(", ")}${still.length > 3 ? ` (+${still.length - 3} more)` : ""}.`, tag: "media" };
    }
    return { text: `${greeting}got your ${ingested.itemLabel}. All documents received — our loan officer will review and call you.`, tag: "media_complete" };
  }
  return {
    text: `${greeting}thanks — I've received your ${noun} and saved it to your file. A colleague will take a look. Is there anything you'd like to know in the meantime?`,
    tag: "media",
  };
}

/* ---- Site visits ---------------------------------------------------------- */

/** The brand this WhatsApp number speaks for. Single-tenant: the connection's brand, else the first. */
function brandFor(): Brand | undefined {
  const db = read();
  const conn = db.connections.find((c) => c.channel === "whatsapp");
  return db.brands.find((b) => b.id === conn?.brandId) ?? db.brands[0];
}

function formatSlot(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-IN", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return new Date(iso).toUTCString();
  }
}

/**
 * Offer the next three bookable slots. When the calendar has nothing (closed,
 * blacked out, full) the request becomes a follow-up so a person proposes a
 * time — the customer is never left with "which days suit you?" and no answer.
 */
function proposeVisit(customerId: string, greeting: string, pref?: VisitPreference | null, lang: Lang = "en"): Composed {
  const customer = getCustomer(customerId)!;
  const brand = brandFor();
  const tz0 = brand?.timezone || "Asia/Kolkata";
  const all = brand ? slots(brand.id, new Date().toISOString(), pref ? 14 : 7) : [];
  const matched = pref ? matchSlots(all, pref, tz0) : [];
  // A stated day with nothing open falls back to the nearest slots, and says so.
  const open = (matched.length ? matched : all).slice(0, 3);
  const missedDay = Boolean(pref && !matched.length && open.length);
  if (!open.length) {
    createFollowUp({
      orgId: customer.orgId,
      customerId,
      kind: "SALES_NUDGE",
      lane: "SALES",
      reason: "Customer asked for a site visit; no bookable slots in the next 7 days — propose a time",
    });
    return { text: `${greeting}yes — we can arrange a viewing. I don't have an open slot in the next few days, so a colleague will message you with times. Which days generally suit you?`, tag: "visit_followup" };
  }
  const tz = brand?.timezone || "Asia/Kolkata";
  const lines = open.map((s, i) => `${i + 1}. ${formatSlot(s.startsAt, tz)}`).join("\n");
  const meta: Record<string, string> = {};
  open.forEach((s, i) => { meta[`slot${i + 1}`] = s.startsAt; });
  const lead = missedDay
    ? "nothing is open at that time, but the nearest available slots are:"
    : matched.length
      ? "yes — here are the times open then:"
      : "yes — we can arrange a viewing. The next available times are:";
  const tail = lang === "hi"
    ? "जो समय ठीक हो उसका नंबर भेजें, या कोई और दिन बताएं।"
    : lang === "hinglish"
      ? "Jo time theek ho uska number reply karein, ya koi aur din batayein."
      : lang === "te"
        ? "మీకు అనుకూలమైన నంబర్ పంపండి, లేదా వేరే రోజు చెప్పండి."
        : "Reply with the number that suits you, or tell me another day.";
  return {
    text: `${greeting}${lead}\n${lines}\n${tail}`,
    tag: "visit_slots",
    meta,
  };
}

/** A slot the customer picked: a button id "slot:<iso>", or "1"/"2"/"3" after an offer. */
function chosenSlot(customerId: string, input: InboundMessage): string | undefined {
  const id = input.interactive?.id;
  if (id?.startsWith("slot:")) return id.slice(5);
  // The whole message must be the pick ("2", "option 2", "2."): a leading
  // digit alone ("2 bhk price?", "3 of us will come") is a question, not a
  // choice, and must not book a visit.
  const n = input.body.trim().match(/^(?:option\s*)?([1-3])\s*[.)]?\s*$/i);
  if (!n) return undefined;
  // The offer is the latest outbound the agent composed for this customer.
  // Automated sends (follow-ups, document notices) may land after it without
  // the customer having replied, so they must not hide the offer.
  const last = read()
    .opsMessages.filter((m) => m.customerId === customerId && m.direction === "outbound" && !m.automated)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return last?.tag === "visit_slots" ? last.meta?.[`slot${n[1]}`] : undefined;
}

/**
 * Send any reply still queued as TEMPLATE_REQUIRED for this customer. Called
 * from handleInbound once the customer has written again (the window is open
 * by definition), so the owed words go out before the fresh answer. Sent
 * follow-ups are marked as such so runFollowUpTick does not repeat them.
 */
async function flushQueuedReplies(orgId: string, customerId: string): Promise<void> {
  const queued = read()
    .followUps.filter((f) => f.customerId === customerId && f.kind === "TEMPLATE_REQUIRED" && f.status === "SCHEDULED" && f.message)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const f of queued) {
    const res = await deliver(orgId, customerId, f.message!, "ai", undefined, { automated: true, tag: "queued_reply" });
    if (res.ok) markSent(f.id);
  }
}

function bookVisit(customer: NonNullable<ReturnType<typeof getCustomer>>, greeting: string, startsAt: string): Composed {
  const brand = brandFor();
  if (!brand) return { text: `${greeting}I couldn't book that just now — a colleague will confirm a time with you.`, tag: "visit_failed" };
  const res = book({
    brandId: brand.id,
    startsAt,
    customerName: customer.name,
    customerPhone: customer.phone,
    leadId: customer.leadId,
    contactId: customer.contactId,
    channel: "whatsapp",
    createdBy: "ai",
    notes: "Booked by the WhatsApp assistant",
  });
  const tz = brand.timezone || "Asia/Kolkata";
  if (res.ok && res.appointment) {
    notifyAppointmentIfPresent(res.appointment);
    return {
      text: `${greeting}you're booked for ${formatSlot(res.appointment.startsAt, tz)}. We'll send a reminder before the visit. If you need to change it, just say so here.`,
      tag: "visit_booked",
      appointmentId: res.appointment.id,
    };
  }
  const alt = (res.alternatives ?? []).slice(0, 3);
  if (!alt.length) return { text: `${greeting}that time has just gone. A colleague will message you with other options.`, tag: "visit_failed" };
  const meta: Record<string, string> = {};
  alt.forEach((s, i) => { meta[`slot${i + 1}`] = s.startsAt; });
  return {
    text: `${greeting}that time has just gone. Next available:\n${alt.map((s, i) => `${i + 1}. ${formatSlot(s.startsAt, tz)}`).join("\n")}\nReply with a number.`,
    tag: "visit_slots",
    meta,
  };
}

/**
 * `src/lib/notify` is owned by another workstream and may not exist yet. Load
 * it at runtime, by real path, so a missing module costs nothing and a present
 * one is used — and the bundler never sees a static import it cannot resolve.
 */
function notifyAppointmentIfPresent(appointment: unknown): void {
  try {
    const file = typeof __filename === "string" && __filename.includes("/") ? __filename : `${process.cwd()}/src/lib/ops/agent.js`;
    const mod = createRequire(file)("../notify") as { notifyAppointment?: (a: unknown, event: "booked") => unknown };
    void Promise.resolve(mod.notifyAppointment?.(appointment, "booked")).catch((e) => console.warn(`[agent] notifyAppointment failed: ${(e as Error).message}`));
  } catch {
    // Not present: nothing to do.
  }
}

/* ---- LLM layer ------------------------------------------------------------ */

/**
 * Vocabulary the model must never use in a customer reply; any hit discards
 * its answer. Word boundaries sit on the word alternatives only — a leading
 * `\b` would make `₹`, `$5`, `10%` and `Rs 95,00,000` unmatchable, since
 * those start or end on a non-word character. The last group is §32: the
 * model may not assert an action (booked/reserved/confirmed/on hold) because
 * no tool ran on its behalf — those phrasings come only from deterministic
 * paths. Bare "confirm" stays allowed: the safe drafts say "will confirm".
 */
const FORBIDDEN = /(\b(approved?|approval|eligible|eligibility|sanction\w*|discount|negotiab\w*|guarantee\w*|lakh|crore|cr|inr|booked|reserved|confirmed|on\s+hold)\b|₹|\$\s?\d|\brs\.?\s?[\d,]+|\d+(?:\.\d+)?\s?%)/i;

/** Figures and currency only — permitted when the prompt carried public price facts. */
const FIGURES = /(\b(lakh|crore|cr|inr)\b|₹|\$\s?\d|\brs\.?\s?[\d,]+|\d+(?:\.\d+)?\s?%)/i;

/** A number attached to money or percentage context: `₹1.98`, `Rs 95,00,000`, `50 lakh`, `10%`. */
const MONEY_FIGURE = /(?:₹|\$|\brs\.?)\s?([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s?(?:(?:lakh|crore|cr|inr)\b|%)/gi;

/** Money figures in `text`, normalised so `1,98,00,000` and `19800000` compare equal. */
function moneyFigures(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MONEY_FIGURE)) {
    const n = Number((m[1] ?? m[2] ?? "").replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(String(n));
  }
  return out;
}

/**
 * True when an LLM completion must not reach the customer. Exported for tests.
 * `publicFacts` is the KB text the prompt carried (entries the admin marked
 * public): every money figure in the reply must appear in it — a figure the
 * model invented or the customer injected is discarded, not merely allowed
 * through. Approval, negotiation and asserted actions stay forbidden regardless.
 */
export function isForbiddenReply(text: string, publicFacts?: string, allowedUrl?: string): boolean {
  if (CREDENTIALS.test(text) || ACTION_STEMS.test(text) || hasForeignUrl(text, allowedUrl)) return true;
  if (!publicFacts) return FORBIDDEN.test(text);
  const allowed = new Set(moneyFigures(publicFacts));
  if (moneyFigures(text).some((f) => !allowed.has(f))) return true;
  return FORBIDDEN.test(text.replace(new RegExp(FIGURES.source, "gi"), " "));
}

/** Credential / PII solicitation — never legitimate over WhatsApp, whatever the model was told. */
const CREDENTIALS = /\b(otp|one[\s-]?time\s+pass\w*|password|passcode|cvv|aadha?ar|pan\s*(?:card|number|no\.?)|card\s*(?:number|no\.?|details)|pin(?!\s*code))\b/i;

/** Present-tense action stems (§32) the word list misses: "I'll reserve", "blocked unit", "hold it". */
const ACTION_STEMS = /\b(reserv\w*|block\w*\s+(?:the\s+|a\s+|that\s+|this\s+)?unit|hold\s+(?:it|this|that|the\s+unit|a\s+unit))\b/i;

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()"']+/gi;

/** True when the reply carries any link other than the brand's own website. */
function hasForeignUrl(text: string, allowedUrl?: string): boolean {
  const norm = (u: string) => u.replace(/^(?:https?:\/\/)?(?:www\.)?/i, "").replace(/[\/.,!?]+$/, "").toLowerCase();
  const allowed = allowedUrl ? norm(allowedUrl) : "";
  for (const m of text.match(URL_RE) ?? []) {
    const u = norm(m);
    if (!allowed || (u !== allowed && !u.startsWith(allowed + "/"))) return true;
  }
  return false;
}

/**
 * Rolling context for the model: what the customer has asked over the last
 * six turns, the facts on their profile, and what we are waiting on. Cheaper
 * than a model-written summary and never wrong about what was said.
 */
export function conversationSummary(customerId: string): string {
  const customer = getCustomer(customerId);
  if (!customer) return "";
  const recent = read()
    .opsMessages.filter((m) => m.customerId === customerId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 6);
  const asked = [...new Set(recent.filter((m) => m.direction === "inbound").map((m) => routeIntent(m.body)).filter((i) => i !== "unknown" && i !== "greeting"))];
  const prefs = Object.entries(customer.preferences ?? {}).filter(([k]) => k !== "sharedLocation").slice(0, 4).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`);
  const lastOut = recent.find((m) => m.direction === "outbound" && !m.automated);
  const booked = (read().appointments ?? []).some((a) => a.customerPhone === customer.phone && a.status === "confirmed" && a.startsAt > new Date().toISOString());
  return [
    asked.length ? `asked about: ${asked.join(", ")}` : "",
    prefs.length ? `known: ${prefs.join("; ")}` : "",
    lastOut?.tag === "visit_slots" ? "site-visit slots were offered, awaiting their pick" : "",
    booked ? "a site visit is already booked" : "",
    `stage ${customer.leadStage}`,
  ].filter(Boolean).join(". ");
}

const RETRY_AFTER_429_MS = 1_500;

/** One completion, retried once after a 429 — the free tier's only common failure. */
async function completeOnce(opts: Parameters<typeof complete>[0]): Promise<string | null> {
  const attempt = async () => {
    try {
      return { out: await complete(opts), limited: rateLimitedRecently() };
    } catch (e) {
      // complete() does not throw by contract; a stubbed one may.
      return { out: null, limited: /429|rate.?limit/i.test((e as Error).message), error: e as Error };
    }
  };
  const first = await attempt();
  if (first.out) return first.out;
  if (!first.limited) {
    if (first.error) throw first.error;
    return null;
  }
  await new Promise((r) => setTimeout(r, RETRY_AFTER_429_MS));
  const second = await attempt();
  if (second.error && !second.out) throw second.error;
  return second.out;
}

/**
 * One grounded completion for the open sales conversation. Budgeted for the
 * Groq free tier: compact prompt, small output, 8s deadline. Returns the
 * reply text, the literal "ESCALATE" when the model says it cannot answer
 * from the facts, or null on any failure — in which case the deterministic
 * draft goes out unchanged.
 */
async function llmReply(customer: NonNullable<ReturnType<typeof getCustomer>>, incoming: string, draft: Composed): Promise<string | null> {
  if (!hasLLM()) return null;
  const brand = brandFor();
  const loanCase = activeCase(customer.id);
  const nextDoc = loanCase ? caseProgress(loanCase.id).missing[0]?.customerLabel : undefined;
  const recent = read()
    .opsMessages.filter((m) => m.customerId === customer.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(1, 7) // skip the message being answered — it is the user turn
    .reverse()
    .map((m) => `${m.direction === "inbound" ? "CUSTOMER" : "YOU"}: ${m.body.slice(0, 240)}`)
    .join("\n");

  const intent = routeIntent(incoming);
  const lang = detectLanguage(incoming);
  const kb = brand ? retrieve(brand.id, incoming, { topic: topicForIntent(intent), k: 3 }) : [];
  const publicPrice = kb.some((e) => e.topic === "pricing" && e.public);
  const kbFacts = factsBlock(kb);

  const facts = [
    `Business: ${brand?.name ?? "the sales team"} (${brand?.industry ?? "real estate"})`,
    brand?.offerings.length ? `Offerings: ${brand.offerings.join("; ")}` : "Offerings: not listed — do not invent any",
    brand?.audience ? `Audience: ${brand.audience}` : "",
    brand?.website ? `Website: ${brand.website}` : "",
    brand?.voice ? `Tone: ${brand.voice.slice(0, 200)}` : "",
    kbFacts ? `Knowledge base:\n${kbFacts}` : "Knowledge base: nothing on this topic",
  ].filter(Boolean).join("\n");

  const priceRule = publicPrice
    ? "You may quote the prices listed in the knowledge base exactly as written; never estimate beyond them, never discount or negotiate."
    : "Never state or estimate a price, discount or payment; say the sales team will confirm pricing.";
  const system = `You are the WhatsApp assistant for a property sales team. Reply in at most 3 short sentences of plain text, no markdown, no emojis, warm and direct.
Reply in ${LANGUAGE_NAME[lang]} — mirror the customer's language.
FACTS (the only things you may state):
${facts}
CUSTOMER: name ${customer.name}; stage ${customer.leadStage}; intent ${customer.intent}${loanCase ? `; has a loan file${nextDoc ? `, next document needed: ${nextDoc}` : ""}` : ""}.
SUMMARY: ${conversationSummary(customer.id) || "first message"}.
RULES: ${priceRule} Never negotiate; never discuss legal terms, contracts, approval or eligibility; never promise dates or outcomes; never claim to have booked or reserved anything. End with exactly one next-step question: a site visit or a callback. If answering needs anything not in FACTS, reply with exactly the single word ESCALATE.
Detected intent: ${intent}. A safe reply you may use or improve: "${draft.text}"`;

  try {
    const out = await completeOnce({
      system,
      prompt: `${recent ? `${recent}\n` : ""}CUSTOMER: ${incoming.slice(0, 500)}\nYOU:`,
      maxTokens: 300,
      temperature: 0.2,
      timeoutMs: 8_000,
    });
    if (!out) return null;
    const text = out.trim().replace(/^YOU:\s*/i, "").replace(/^INTENT:[^\n]*\n?/i, "").replace(/\s+/g, " ").slice(0, 600);
    if (!text) return null;
    if (/^ESCALATE\b/i.test(text) || /\bESCALATE\b/.test(text) && text.length < 40) return "ESCALATE";
    // Off-limits vocabulary means the model wandered past the facts; the
    // deterministic sentence is the safer answer.
    if (isForbiddenReply(text, publicPrice ? kbFacts : undefined, brand?.website)) return null;
    return withNextStep(text, lang);
  } catch (e) {
    console.warn(`[agent] LLM reply failed: ${(e as Error).message}`);
    return null;
  }
}

/* ---- Deterministic composer ---------------------------------------------- */

export function composeReply(customerId: string, incoming: string, escalated: boolean, opts: { caseOpened?: boolean } = {}): Composed | null {
  const ctx = { orgId: getCustomer(customerId)!.orgId, customerId, actorType: "ai" as const };
  const profile = TOOLS.get_customer_profile(ctx);
  if (!profile.ok) return null;
  const first = profile.data.name.split(" ")[0];
  const greeting = profile.data.name === "Unknown" ? "" : `${first}, `;
  const bounded = (text: string, tag: string): Composed => ({ text, tag });

  if (INTENT_PATTERNS.approval.test(incoming)) {
    // Never speculate about approval. This is a hard boundary, not a style choice.
    return bounded(`${greeting}I can't give you a view on approval — that's decided by our loan team once your file is complete. I've asked them to come back to you on it.`, "approval");
  }

  // Price negotiation and legal terms are human conversations. Escalate on
  // the spot and say so, rather than letting either path near the model.
  const handoff = humanOnly(ctx, incoming);
  if (handoff) return handoff.tag === "negotiation"
    ? { text: `${greeting}I can't negotiate pricing myself, but I've passed this to the sales team — someone will come back to you directly on what's possible.`, tag: "handoff", escalationId: handoff.escalationId }
    : { text: `${greeting}that's a legal question, so I'd rather a colleague answered it properly. I've passed it on and someone will come back to you.`, tag: "handoff", escalationId: handoff.escalationId };

  const caseResult = TOOLS.get_loan_case(ctx);
  if (caseResult.ok) {
    // The file was just opened, or the customer asked what is needed: the
    // numbered list, not the one-at-a-time nudge.
    if (opts.caseOpened || DOCS_QUESTION.test(incoming)) return documentListReply(customerId, greeting, Boolean(opts.caseOpened));
    const missing = TOOLS.get_missing_documents(ctx);
    if (!missing.ok) return bounded(`${greeting}thanks — I'll come back to you shortly.`, "loan");
    const { rejected, awaitingReview, missing: outstanding, completionPct } = missing.data;

    if (rejected.length) {
      const r = rejected[0];
      return bounded(`${greeting}we need a new copy of your ${r.label}. The team noted: ${sentence(r.reason ?? "it couldn't be accepted as submitted")} You can send the replacement right here.`, "loan");
    }
    if (outstanding.length) {
      const next = outstanding[0];
      const pending = awaitingReview.length ? ` Your ${awaitingReview[0].label} is with the team for review.` : "";
      return bounded(`${greeting}thanks.${pending} The next thing we need is your ${next.label} — ${sentence(next.description)}`, "loan");
    }
    if (awaitingReview.length) {
      // "received", never "accepted": no human has looked at it yet.
      return bounded(`${greeting}all documents received — our loan officer will review them and call you.`, "loan");
    }
    if (completionPct === 100) {
      return bounded(`${greeting}all the documents we asked for have been received and accepted. Your application is with the loan team now — they'll be in touch with next steps.`, "loan");
    }
  }

  // Handoff and callback requests are answered with a concrete promise (who,
  // by when) even when other rules already escalated this message — "passed
  // it to a colleague" is not an answer to "connect me to a salesman".
  const routed = routeIntent(incoming);
  const lang = detectLanguage(incoming);
  if (routed === "human" || routed === "callback") return humanHandoff(ctx, greeting, incoming, routed, lang);
  if (routed === "thanks") return bounded(deterministicReply("thanks", { greeting, lang, entries: [] }), "thanks");

  if (escalated) {
    return bounded(`${greeting}thanks for flagging that — I've passed it to a colleague who'll come back to you directly.`, "handoff");
  }

  // Factual questions are answered from the knowledge base before the lead
  // temperature is consulted: a hot lead asking about schools still wants the
  // schools, and the team's call happens regardless.
  const grounded = knowledgeReply(ctx, greeting, incoming, routed, lang);
  if (grounded) return { ...grounded, text: notRepeated(customerId, grounded.text) };

  const status = TOOLS.get_lead_status(ctx);
  if (status.ok && ["HOT", "VERY_HOT"].includes(status.data.band)) {
    return bounded(notRepeated(customerId, `${greeting}thanks — that's helpful. Someone from the team will call you shortly to go through the details.`), "hot");
  }

  // Answer *this* message first. Intent is cumulative across the conversation,
  // so keying only on it makes "is anything available in March?" and "could I
  // see it in person?" collapse into the same reply — which is exactly the kind
  // of not-listening that makes people ask for a human.
  const direct = replyToMessage(customerId, incoming, greeting, routed, lang);
  if (direct) return { ...direct, text: notRepeated(customerId, direct.text) };

  // Nothing matched. Ask once; the second consecutive blank is a human's job.
  // `routed` covers the Devanagari/Telugu greetings GREETING cannot see.
  if (routed !== "greeting" && !GREETING.test(incoming) && !ACK.test(incoming)) return clarify(ctx, greeting, incoming);

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

  return bounded(
    notRepeated(customerId, byIntent[intent] ?? `${greeting}thanks for getting in touch. What would be most useful to know first?`),
    "greeting",
  );
}

const GREETING = /^\s*(hi|hello|hey|hii+|good (morning|afternoon|evening)|namaste|namaskar|thanks?|thank you|ok(ay)?|sure|yes|no|great|fine)\b/i;
const ACK = /^\s*[\p{Emoji}\s.!?,]*$/u;
const NEGOTIATION = /\b(discount|negotiat\w*|best (price|rate|offer)|lowest|final price|reduce|bring (it|the price) down|any offer|deal on|cheaper|price is (too )?high)\b/i;
// "rera" is deliberately absent: "is it RERA approved?" is a fact the KB holds
// (the approvals intent), whereas the terms below are advice a human gives.
const LEGAL = /\b(legal|lawyer|advocate|contract|agreement terms|clause|stamp duty|registration|title deed|litigation|encumbrance|power of attorney|terms and conditions)\b/i;

/** Knowledge-base intents answered from stored facts; the rest stay on their own paths. */
const KB_INTENTS = new Set<RoutedIntent>(["location", "amenities", "approvals", "payment", "documents"]);

/** The brand's knowledge base, seeded on first use. */
function knowledgeFor(): Brand | undefined {
  const brand = brandFor();
  if (brand) ensureKnowledge(brand.id);
  return brand;
}

/**
 * Answer a factual intent from the top-3 matching KB entries. No match logs a
 * gap for the admin and tells the customer honestly, rather than guessing.
 */
function knowledgeReply(ctx: { orgId: string; customerId: string }, greeting: string, incoming: string, intent: RoutedIntent, lang: Lang): Composed | null {
  if (!KB_INTENTS.has(intent)) return null;
  const brand = knowledgeFor();
  const entries = brand ? retrieve(brand.id, incoming, { topic: topicForIntent(intent), k: 3 }) : [];
  if (!entries.length && brand) logGap({ brandId: brand.id, question: incoming, intent, customerId: ctx.customerId });
  return { text: deterministicReply(intent, { greeting, lang, entries }), tag: intent, meta: entries.length ? { kb: entries.map((e) => e.id).join(",") } : undefined };
}

/**
 * Human handoff: escalate to the assigned sales manager (assigning one first
 * if nobody owns the lead), notify them, and tell the customer who calls and
 * by when. A callback request is the same promise without the escalation
 * severity — it is routine, not a failure of the assistant.
 */
function humanHandoff(ctx: { orgId: string; customerId: string }, greeting: string, incoming: string, intent: "human" | "callback", lang: Lang): Composed {
  const customer = getCustomer(ctx.customerId)!;
  if (!customer.assignedSalesManagerId) {
    try {
      assign({ orgId: ctx.orgId, customerId: ctx.customerId, queue: "SALES", reason: intent === "human" ? "Customer asked for a salesperson" : "Customer asked for a callback", actorType: "ai" });
    } catch (e) {
      console.warn(`[agent] could not assign a sales manager: ${(e as Error).message}`);
    }
  }
  const owner = getCustomer(ctx.customerId)!.assignedSalesManagerId;
  const manager = owner ? read().teamMembers.find((m) => m.id === owner) : undefined;
  const window = callbackWindow(new Date(), brandFor()?.timezone || "Asia/Kolkata");
  const e = escalate({
    ...ctx,
    ruleId: intent === "human" ? "requested_human" : "callback_requested",
    lane: "SALES",
    severity: intent === "human" ? "HIGH" : "MEDIUM",
    reason: intent === "human" ? "Customer requested a human" : "Customer asked for a callback",
    detail: `${incoming.slice(0, 160)} — promised a call ${window}.`,
    assignedToId: owner,
  });
  // escalate() notifies once per open escalation; a repeat request still
  // deserves a nudge to the owner, so the promise to the customer stays true.
  notify({
    orgId: ctx.orgId,
    recipientId: owner,
    recipientRole: owner ? undefined : "SALES_MANAGER",
    category: "SALES",
    event: intent === "human" ? "customer.requested_human" : "customer.requested_callback",
    title: `${customer.name} wants a call ${window}`,
    body: incoming.slice(0, 200),
    customerId: ctx.customerId,
    severity: intent === "human" ? "WARNING" : "INFO",
  });
  const who = manager ? manager.name.split(" ")[0] : undefined;
  return {
    text: deterministicReply(intent, { greeting, lang, entries: [], handoffTo: who ? (lang === "en" ? `${who} from our sales team` : who) : undefined, window }),
    tag: intent === "human" ? "handoff" : "callback",
    escalationId: e?.id,
  };
}

/** Escalate the two subjects the assistant must never handle. Returns the escalation for the reply to cite. */
function humanOnly(ctx: { orgId: string; customerId: string }, incoming: string): { tag: "negotiation" | "legal"; escalationId?: string } | null {
  const cfg = getConfig(ctx.orgId);
  // Rules added after a config was stored are absent from it; absence is "on".
  const enabled = (id: string) => cfg.escalations.find((e) => e.id === id)?.enabled ?? true;
  if (enabled("price_negotiation") && NEGOTIATION.test(incoming)) {
    const e = escalate({ ...ctx, ruleId: "price_negotiation", lane: "SALES", severity: "HIGH", reason: "Customer wants to negotiate price", detail: incoming.slice(0, 160) });
    return { tag: "negotiation", escalationId: e?.id };
  }
  if (enabled("legal_question") && LEGAL.test(incoming)) {
    const e = escalate({ ...ctx, ruleId: "legal_question", lane: "SALES", severity: "MEDIUM", reason: "Customer asked about legal terms", detail: incoming.slice(0, 160) });
    return { tag: "legal", escalationId: e?.id };
  }
  return null;
}

/**
 * Polite clarification, escalating on the second consecutive miss. The streak
 * is read from our own outbound tags — two "clarify" replies in a row means
 * the customer has now typed the same unreadable thing twice and a human
 * should take it from here.
 */
function clarify(ctx: { orgId: string; customerId: string }, greeting: string, incoming: string): Composed {
  const last = read()
    .opsMessages.filter((m) => m.customerId === ctx.customerId && m.direction === "outbound")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const brand = knowledgeFor();
  if (brand) logGap({ brandId: brand.id, question: incoming, intent: "unknown", customerId: ctx.customerId });
  if (last?.tag === "clarify") {
    const e = escalate({ ...ctx, ruleId: "ai_unknown", lane: "SALES", severity: "MEDIUM", reason: "Assistant could not understand twice in a row", detail: incoming.slice(0, 160) });
    return { text: `${greeting}sorry, I'm not following — I've asked a colleague to step in, and they'll message you directly.`, tag: "handoff", escalationId: e?.id };
  }
  return { text: `${greeting}sorry, I didn't quite catch that. Are you asking about pricing, availability, a site visit, or financing?`, tag: "clarify" };
}

/**
 * Match the specific thing the customer just asked. Ordered most-specific
 * first, because a message can trip several patterns at once ("what does it
 * cost and can I visit?") and the visit is the more actionable half.
 */
function replyToMessage(customerId: string, incoming: string, greeting: string, routed: RoutedIntent, lang: Lang): Composed | null {
  if (INTENT_PATTERNS.visit.test(incoming)) return proposeVisit(customerId, greeting, parseVisitPreference(incoming), lang);
  const brand = knowledgeFor();
  const offerings = brand?.offerings.filter(Boolean).slice(0, 5) ?? [];
  const listed = offerings.length ? ` We currently offer: ${offerings.join(", ")}.` : "";
  const kb = (topic: KbTopic) => (brand ? retrieve(brand.id, incoming, { topic, k: 3 }) : []);
  // INTENT_PATTERNS is English-only; the router also knows the script forms
  // (ధర ఎంత?, कीमत), and those get the mirrored deterministic reply.
  if (lang !== "en" && (routed === "availability" || routed === "pricing")) {
    return { text: deterministicReply(routed, { greeting, lang, entries: kb(routed) }), tag: routed };
  }
  if (INTENT_PATTERNS.availability.test(incoming)) {
    const facts = factsSentence(kb("availability"), { withholdPrices: true });
    return { text: `${greeting}let me check what's available for that period and come back to you with specifics.${listed}${facts ? ` ${facts}` : ""} Would you like to book a site visit in the meantime?`, tag: "availability" };
  }
  if (INTENT_PATTERNS.financing.test(incoming)) {
    const facts = factsSentence(kb("payment"), { withholdPrices: true });
    return { text: `${greeting}we can talk through financing.${facts ? ` ${facts}` : ""} Roughly what amount were you thinking of borrowing?`, tag: "sales" };
  }
  if (INTENT_PATTERNS.pricing.test(incoming)) {
    // A figure reaches the customer only from a KB entry the admin marked
    // public. Otherwise pricing is confirmed by the sales team: name what
    // exists and move toward the visit, which is where prices get discussed.
    const pub = factsSentence(kb("pricing").filter((e) => e.public));
    const line = pub ? `${greeting}${pub}` : `${greeting}thanks for asking — the sales team will confirm current pricing for you.${listed}`;
    return { text: `${line} Is there a particular size you have in mind, and would you like to see it in person?`, tag: "pricing" };
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
  opts: { automated?: boolean; tag?: string; meta?: Record<string, string> } = {},
): Promise<{ ok: boolean; error?: string; requiresTemplate?: boolean; followUpId?: string }> {
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
    // Outside the 24h window a free-form send cannot deliver. Instead of
    // dropping the words: queue them as a follow-up that retries once the
    // customer writes again (reopening the window), and hand a person the
    // task of sending an approved template or calling. Follow-ups themselves
    // are excluded — a queued follow-up must not spawn another one per tick.
    let followUpId: string | undefined;
    if (res.requiresTemplate && !opts.automated) {
      const lane = activeCase(customerId) ? "LOAN" : "SALES";
      followUpId = createFollowUp({
        orgId,
        customerId,
        kind: "TEMPLATE_REQUIRED",
        lane,
        message: body,
        scheduledAt: new Date().toISOString(),
        reason: "Reply blocked by the 24-hour WhatsApp window; retries when the customer writes again",
      })?.id;
      escalate({
        orgId,
        customerId,
        ruleId: "window_closed",
        lane,
        severity: "MEDIUM",
        reason: "Reply blocked by the 24h WhatsApp window",
        detail: `Could not send: "${body.slice(0, 120)}". Send an approved template or call the customer.`,
      });
    }
    return { ok: false, error: res.error, requiresTemplate: res.requiresTemplate, followUpId };
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
    tag: opts.tag,
    meta: opts.meta,
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
  /** 24h-before site-visit reminders sent on the same tick. */
  reminders?: ReminderTickResult;
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
  result.reminders = await sendDueReminders();
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
