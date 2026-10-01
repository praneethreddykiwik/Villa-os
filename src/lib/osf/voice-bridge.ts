import { complete, extractJson, hasLLM } from "../ai/provider";
import { db } from "./supabase";
import { getOrCreateLead } from "./conversation";
import { scoreLead, temperatureFor } from "./agent/scoring";
import { activeProvider, deliverReply, sendPlainText, sendReengagement } from "./whatsapp/outbound";
import { deliverApprovedAssets } from "./agent/execute";
import { getOrCreateConversation } from "./conversation";
import { serviceWindow } from "./communication";
import { env } from "./env";
import { logActivity } from "./activities";
import type { AssetKind, BuyerPurpose, Lead, LeadTemperature, PurchaseTimeline } from "./types";

/**
 * THE BRIDGE BETWEEN THE CALL AND THE WHATSAPP THREAD
 *
 * A call ends, Bolna posts the transcript, and until now that was where the
 * voice side stopped: it wrote a customer, a transcript and a lead into the
 * JSON store, and the WhatsApp agent — which keeps its leads in Supabase —
 * never learned any of it. The same buyer, reached on the same number, existed
 * twice and neither half knew about the other.
 *
 * This module closes that. Given a finished call it:
 *
 *   1. reads FACTS out of the transcript,
 *   2. scores them with the same deterministic scorer the WhatsApp agent uses,
 *   3. writes the result onto the Supabase lead keyed by that phone number —
 *      the very record the WhatsApp agent reads and writes,
 *   4. and sends a follow-up appropriate to how the call actually went.
 *
 * WHY THE MODEL DOES NOT DECIDE THE TEMPERATURE
 *
 * It would be easy to ask an LLM "is this hot, warm or cold?". We deliberately
 * do not. `scoring.ts` says why: the score is rule-based "so the sales team can
 * see exactly why a lead is hot and the number means the same thing today as it
 * did last month". A model asked the same question twice gives two answers, and
 * nobody can audit it. So the model does the part it is genuinely good at —
 * pulling structured facts out of unstructured speech — and the arithmetic that
 * decides who gets called back stays deterministic and inspectable.
 *
 * Without an LLM configured this still works: `keywordSignals` reads the same
 * facts with patterns. Worse recall, identical scoring, no silent failure.
 */

/** What we try to learn from a transcript. Every field optional — calls ramble. */
export interface CallSignals {
  name?: string | null;
  purchaseTimeline?: PurchaseTimeline | null;
  buyerPurpose?: BuyerPurpose | null;
  bedrooms?: number | null;
  budgetMaxInr?: number | null;
  requestedSiteVisit?: boolean;
  askedAboutBooking?: boolean;
  requestedMaterial?: boolean;
  requestedHandoff?: boolean;
  /**
   * WHAT the caller asked to be sent, not merely that they asked for something.
   * `requestedMaterial` is a scoring input; this is a work order — each kind
   * here is fulfilled from the operator's approved asset list after the call.
   */
  requestedAssetKinds?: AssetKind[];
  /** "Send me the location" — a maps link, never an attachment. */
  requestedLocation?: boolean;
  /** Turns the CUSTOMER spoke — engagement, not call length. */
  customerTurns?: number;
  /** One line a human can read in the CRM. Never shown to the customer. */
  summary?: string | null;
}

const TIMELINES: PurchaseTimeline[] = [
  "immediate", "within_1_month", "1_3_months", "3_6_months", "6_12_months", "researching", "unknown",
];
const PURPOSES: BuyerPurpose[] = [
  "self_use", "family", "investment", "second_home", "vacation_home", "rental_income", "nri_purchase", "undecided",
];

/** Keep only values the schema actually accepts — a model will invent neighbours. */
function coerce(raw: Record<string, unknown>): CallSignals {
  const timeline = String(raw.purchaseTimeline ?? "").trim() as PurchaseTimeline;
  const purpose = String(raw.buyerPurpose ?? "").trim() as BuyerPurpose;
  const beds = Number(raw.bedrooms);
  const budget = Number(raw.budgetMaxInr);
  return {
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 80) : null,
    purchaseTimeline: TIMELINES.includes(timeline) ? timeline : null,
    buyerPurpose: PURPOSES.includes(purpose) ? purpose : null,
    bedrooms: Number.isFinite(beds) && beds > 0 && beds < 15 ? Math.round(beds) : null,
    // A model that hears "one crore" sometimes writes 1. Anything below a lakh
    // is a misread, not a budget, and letting it through would mark a serious
    // buyer as having disclosed an absurd ceiling.
    budgetMaxInr: Number.isFinite(budget) && budget >= 100_000 ? Math.round(budget) : null,
    requestedSiteVisit: raw.requestedSiteVisit === true,
    askedAboutBooking: raw.askedAboutBooking === true,
    requestedMaterial: raw.requestedMaterial === true,
    requestedHandoff: raw.requestedHandoff === true,
    requestedAssetKinds: Array.isArray(raw.requestedAssets)
      ? [...new Set(raw.requestedAssets.map(String))].filter(
          (k): k is AssetKind => (SENDABLE_KINDS as readonly string[]).includes(k),
        )
      : [],
    requestedLocation: raw.requestedLocation === true,
    summary: typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim().slice(0, 400) : null,
  };
}

/**
 * The kinds a post-call follow-up may deliver on its own.
 *
 * Deliberately narrower than `AssetKind`. "image", "video" and "other" are
 * excluded: a caller who said "send me some photos" is asking a salesperson to
 * choose, and an unattended process picking four files out of the library is
 * how someone receives a stranger's floor plan. Those become a human task.
 */
const SENDABLE_KINDS = [
  "brochure", "floor_plan", "site_plan", "master_plan", "price_sheet", "virtual_tour",
] as const satisfies readonly AssetKind[];

/** Phrases that name a specific deliverable, in English and common Hinglish. */
const KIND_PATTERNS: ReadonlyArray<[AssetKind, RegExp]> = [
  ["brochure", /\b(brochure|broucher|catalogue|catalog|pamphlet)\b/],
  ["floor_plan", /\b(floor ?plan|unit plan|layout of the (villa|unit|flat)|2d plan)\b/],
  ["site_plan", /\b(site ?plan|site layout|plot layout)\b/],
  ["master_plan", /\b(master ?plan|project layout|overall layout)\b/],
  ["price_sheet", /\b(price (list|sheet|chart)|rate (list|chart)|cost sheet|payment schedule)\b/],
  ["virtual_tour", /\b(virtual tour|3d tour|walkthrough|walk ?through)\b/],
];

/**
 * "Send me the location" is its own thing. A maps URL is a web page, not a
 * file — `getAssets` refuses to attach one for exactly this reason — so it is
 * delivered as text.
 */
const LOCATION_PATTERN =
  /\b(location|address|where (is|are) (it|the)|google ?maps?|map link|pin|directions|kaha(n)? hai)\b/;

/**
 * Only the caller's own lines.
 *
 * This matters far more here than it does for scoring. The agent says "shall I
 * send you the brochure?" on practically every call, so a whole-transcript
 * match would mail a brochure to someone who answered "no, thanks". The
 * transcript the webhook builds is "Caller: …" / "Agent: …" line-prefixed;
 * when it is an unlabelled blob we have no way to tell the two apart, so the
 * whole thing is used and the model pass — which is told to attribute — is what
 * keeps it honest.
 */
function callerLines(transcript: string): string {
  const lines = transcript.split("\n");
  const labelled = lines.filter((l) => /^\s*(caller|customer|user)\s*:/i.test(l));
  return (labelled.length ? labelled : lines).join("\n").toLowerCase();
}

/** What the caller asked to be SENT, read off the transcript with patterns. */
function requestedKindsFromText(t: string): AssetKind[] {
  return KIND_PATTERNS.filter(([, re]) => re.test(t)).map(([kind]) => kind);
}

/** The deterministic floor. Runs with no model, and alongside one. */
export function keywordSignals(transcript: string): CallSignals {
  const t = transcript.toLowerCase();
  const said = callerLines(transcript);
  const has = (re: RegExp) => re.test(t);
  return {
    requestedAssetKinds: requestedKindsFromText(said),
    requestedLocation: LOCATION_PATTERN.test(said),
    requestedSiteVisit: has(/\b(site visit|visit the site|come and see|show me the (villa|property|plot)|schedule a visit|site dekh)/),
    askedAboutBooking: has(/\b(book|booking|token|advance|payment plan|emi|down payment|register)/),
    requestedMaterial: has(/\b(brochure|floor plan|price list|price sheet|send me the details|pdf)/),
    requestedHandoff: has(/\b(talk to (a|someone|your) (person|human|manager|sales)|call me back|speak to someone)/),
    purchaseTimeline: has(/\b(immediately|right away|this month|as soon as possible|urgent)/)
      ? "immediate"
      : has(/\b(next month|within a month)/)
        ? "within_1_month"
        : has(/\b(just looking|just checking|browsing|researching|exploring)/)
          ? "researching"
          : null,
  };
}

/**
 * Pull facts out of the transcript. Returns the keyword floor when no model is
 * configured, or when the model's answer cannot be parsed.
 */
export async function extractCallSignals(transcript: string): Promise<CallSignals> {
  const floor = keywordSignals(transcript);
  if (!hasLLM() || transcript.trim().length < 40) return floor;

  try {
    const text = await complete({
      system:
        "You extract structured facts from sales call transcripts for a villa developer. " +
        "You never guess. A fact the caller did not state is null. You answer with JSON only.",
      prompt: `Read this call transcript and extract only what the CALLER actually said.

TRANSCRIPT:
${transcript.slice(0, 12_000)}

Return exactly this JSON object, no prose, no fences:
{
 "name": string|null,
 "purchaseTimeline": ${TIMELINES.map((t) => `"${t}"`).join("|")}|null,
 "buyerPurpose": ${PURPOSES.map((p) => `"${p}"`).join("|")}|null,
 "bedrooms": number|null,
 "budgetMaxInr": number|null,
 "requestedSiteVisit": boolean,
 "askedAboutBooking": boolean,
 "requestedMaterial": boolean,
 "requestedHandoff": boolean,
 "requestedAssets": string[],
 "requestedLocation": boolean,
 "summary": string
}

Rules:
- budgetMaxInr in rupees as a number. "one crore" is 10000000, "80 lakhs" is 8000000. Null if no figure was said.
- Booleans are true only if the CALLER asked. The agent offering something does not count.
- requestedAssets: which of ${SENDABLE_KINDS.map((k) => `"${k}"`).join(", ")} the CALLER asked to be SENT to them. This drives an automatic WhatsApp delivery, so include a kind only if they clearly wanted it. If the agent offered and the caller declined or did not answer, leave it out. [] if none.
- requestedLocation: true only if the caller asked where the project is, or asked for the address, map or directions.
- summary: one sentence, factual, for the sales team.`,
      json: true,
      maxTokens: 900,
      timeoutMs: 20_000,
      temperature: 0.1,
    });

    const parsed = extractJson<Record<string, unknown>>(text);
    if (!parsed) return floor;
    const model = coerce(parsed);

    // Union with the keyword pass: a regex hit is evidence the model missed,
    // and these booleans only ever raise the score, never lower it.
    return {
      ...model,
      requestedSiteVisit: model.requestedSiteVisit || floor.requestedSiteVisit,
      askedAboutBooking: model.askedAboutBooking || floor.askedAboutBooking,
      requestedMaterial: model.requestedMaterial || floor.requestedMaterial,
      requestedHandoff: model.requestedHandoff || floor.requestedHandoff,
      // Union here too: the model reads "bhej dijiye woh paper" that no regex
      // has, and the regex catches what a terse model reply drops. Both were
      // read off the caller's own words, so neither can invent a request.
      requestedAssetKinds: [
        ...new Set([...(model.requestedAssetKinds ?? []), ...(floor.requestedAssetKinds ?? [])]),
      ],
      requestedLocation: Boolean(model.requestedLocation || floor.requestedLocation),
      purchaseTimeline: model.purchaseTimeline ?? floor.purchaseTimeline ?? null,
    };
  } catch {
    return floor;
  }
}

/** Which template a call of this temperature earns. Cold gets nothing. */
export const FOLLOW_UP_TEMPLATE: Record<LeadTemperature, string | null> = {
  hot: "call_followup_hot",
  warm: "call_followup_warm",
  // A buyer who said "just browsing" does not want a message thirty seconds
  // later. The call is recorded and scored; silence is the correct follow-up.
  cold: null,
};

export interface BridgeResult {
  leadId: string | null;
  temperature: LeadTemperature | null;
  score: number | null;
  messaged: boolean;
  /** Why nothing was sent, when nothing was sent. */
  skipped?: string;
  /** What the caller asked for on the call, and what became of it. */
  requests?: FulfilmentResult;
}

export interface FulfilmentResult {
  /** Kinds the caller asked to be sent. */
  requested: AssetKind[];
  /** Kinds actually delivered, with the file count for each. */
  delivered: Partial<Record<AssetKind, number>>;
  locationSent: boolean;
  /**
   * Asked for, but nothing went out — no approved file of that kind, or the
   * send failed. These are handed to a human rather than dropped.
   */
  unfulfilled: AssetKind[];
  /** Set when the 24-hour service window was shut, so nothing could be sent. */
  deferred?: string;
}

/** Customer-facing label. Never the enum. */
const KIND_LABEL: Record<string, string> = {
  brochure: "the brochure",
  floor_plan: "the floor plan",
  site_plan: "the site plan",
  master_plan: "the master plan",
  price_sheet: "the price sheet",
  virtual_tour: "the virtual tour",
};

function listOut(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * ACT ON WHAT THE CALLER ASKED FOR.
 *
 * The agent says "sure, I will send it on WhatsApp" and, until now, nothing
 * did. This delivers it — but only from `villa_assets` rows the operator has
 * marked `shareable_by_ai`, through `deliverApprovedAssets`, which re-runs the
 * allowlist and is-it-really-a-file checks the live agent uses. Nothing here
 * can send a URL a human has not approved.
 *
 * WHY THIS CAN LEGITIMATELY SEND NOTHING
 *
 * Meta only permits free-form messages and attachments inside 24 hours of the
 * customer's last inbound WhatsApp message. A voice call does not open that
 * window — only a WhatsApp message from them does. So for a caller who has
 * never messaged us, the lawful move is the approved template, and the
 * brochure follows when they reply. That is reported as `deferred`, not as a
 * success, and the request is logged so a human can see it is outstanding.
 */
export async function fulfilCallRequests(input: {
  lead: Lead;
  phone: string;
  signals: CallSignals;
  executionId: string;
}): Promise<FulfilmentResult | null> {
  const { lead, phone, signals } = input;
  const requested = (signals.requestedAssetKinds ?? []).filter(
    (k): k is AssetKind => (SENDABLE_KINDS as readonly string[]).includes(k),
  );
  const wantsLocation = Boolean(signals.requestedLocation) && Boolean(env.projectMapsUrl);
  if (requested.length === 0 && !wantsLocation) return null;

  const result: FulfilmentResult = {
    requested,
    delivered: {},
    locationSent: false,
    unfulfilled: [],
  };

  // Evolution is our own WhatsApp session — no template regime, no window.
  if (activeProvider() === "meta") {
    const { data: lastInbound } = await db()
      .from("villa_messages")
      .select("created_at")
      .eq("lead_id", lead.id)
      .eq("role", "customer")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!serviceWindow(lastInbound?.created_at ?? null).open) {
      result.deferred =
        "the 24-hour WhatsApp service window is closed — sent the approved template instead, and the request is queued for their reply";
      result.unfulfilled = requested;
      return result;
    }
  }

  const conversation = await getOrCreateConversation(lead.id, "whatsapp");
  const deliver = (reply: Parameters<typeof deliverReply>[1]) => deliverReply(phone, reply);

  const wanted = listOut([
    ...requested.map((k) => KIND_LABEL[k] ?? k.replace(/_/g, " ")),
    ...(wantsLocation ? ["the location"] : []),
  ]);
  const greeting = lead.name ? `Hi ${lead.name}` : "Hi";
  await sendPlainText(phone, `${greeting} — as promised on the call, here is ${wanted}.`).catch(() => {});

  for (const kind of requested) {
    let sent = 0;
    try {
      sent = await deliverApprovedAssets({
        lead,
        conversationId: conversation.id,
        kind,
        deliver,
        caption: KIND_LABEL[kind]
          ? `${KIND_LABEL[kind][0].toUpperCase()}${KIND_LABEL[kind].slice(1)}`
          : undefined,
      });
    } catch {
      sent = 0;
    }
    if (sent > 0) result.delivered[kind] = sent;
    else result.unfulfilled.push(kind);
  }

  if (wantsLocation) {
    // A maps short-link is a web page, so it goes as text. Attaching it
    // produces an unopenable `location-map.pdf` — see getAssets.
    try {
      await sendPlainText(phone, `Here is the location: ${env.projectMapsUrl}`);
      result.locationSent = true;
    } catch {
      /* reported below as an unmet request */
    }
  }

  /**
   * Take back the promise when nothing arrived.
   *
   * The "as promised on the call, here is the brochure" line goes out before
   * the files, because a document landing with no context reads as spam. The
   * cost of that order is this case: every send failed — an unreachable file,
   * a refused upload, a closed session — and the customer is left holding a
   * sentence about an attachment that does not exist. Saying nothing is worse
   * than admitting it; they would sit there waiting and conclude we are
   * broken. A human is already being brought in by the handoff below.
   */
  const deliveredAny = Object.keys(result.delivered).length > 0 || result.locationSent;
  if (!deliveredAny) {
    await sendPlainText(
      phone,
      "Sorry — that didn't attach properly at my end. " +
        "Someone from our team will send it across to you shortly.",
    ).catch(() => {});
  }

  return result;
}

/**
 * Run after a call is FINALISED. Never throws: a follow-up that fails must not
 * cost us the call record the webhook already wrote.
 */
export async function bridgeCallToWhatsApp(input: {
  phone: string | null | undefined;
  name?: string | null;
  transcript: string;
  /** Bolna's execution id — the dedup key. */
  executionId: string;
  customerTurns?: number;
}): Promise<BridgeResult> {
  const empty: BridgeResult = { leadId: null, temperature: null, score: null, messaged: false };

  const phone = (input.phone ?? "").replace(/[^\d+]/g, "");
  if (!phone) return { ...empty, skipped: "the call carried no phone number" };

  try {
    // A webhook retry must not message the same person twice. Bolna retries on
    // any non-2xx, and this runs after the record is already written, so
    // without this the second delivery is a duplicate message to a customer.
    const { data: seen } = await db()
      .from("villa_activities")
      .select("id")
      .eq("activity_type", "voice_followup")
      .contains("metadata", { executionId: input.executionId })
      .limit(1);
    if (seen && seen.length > 0) {
      return { ...empty, skipped: "already handled — this is a webhook retry" };
    }

    const signals = await extractCallSignals(input.transcript);

    const lead = await getOrCreateLead({
      phone,
      name: input.name ?? signals.name ?? null,
      channel: "voice",
      attribution: { source: "voice_call" },
    });

    // Fill in only what the call actually taught us. A call that never
    // mentioned budget must not blank a budget WhatsApp already captured.
    const patch: Record<string, unknown> = {};
    if (signals.purchaseTimeline) patch.purchase_timeline = signals.purchaseTimeline;
    if (signals.buyerPurpose) patch.buyer_purpose = signals.buyerPurpose;
    if (signals.bedrooms !== null && signals.bedrooms !== undefined) patch.bedrooms = signals.bedrooms;
    if (signals.budgetMaxInr) patch.budget_max_inr = signals.budgetMaxInr;
    if (signals.name && !lead.name) patch.name = signals.name;

    const merged = { ...lead, ...patch } as Lead;
    const score = scoreLead(merged, {
      requestedSiteVisit: signals.requestedSiteVisit,
      askedAboutBooking: signals.askedAboutBooking,
      requestedHandoff: signals.requestedHandoff,
      requestedMaterial: signals.requestedMaterial,
      customerMessageCount: input.customerTurns ?? signals.customerTurns ?? 0,
    });
    const temperature = temperatureFor(score);

    // Never cool a lead on the strength of one quiet call — a buyer who was
    // hot on WhatsApp and terse on the phone is still hot.
    const RANK: Record<LeadTemperature, number> = { cold: 0, warm: 1, hot: 2 };
    const existing = (lead.lead_temperature ?? "cold") as LeadTemperature;
    const finalTemperature = RANK[temperature] >= RANK[existing] ? temperature : existing;

    patch.lead_temperature = finalTemperature;
    patch.lead_score = Math.max(score, Number(lead.lead_score ?? 0));
    patch.last_contact_at = new Date().toISOString();

    await db().from("villa_leads").update(patch).eq("id", lead.id);

    await logActivity({
      leadId: lead.id,
      type: "voice_followup",
      channel: "voice",
      description: signals.summary ?? `Call scored ${score} (${finalTemperature}).`,
      // The execution id lives here because it is also the dedup key above.
      metadata: { executionId: input.executionId, score, temperature: finalTemperature },
    }).catch(() => {});

    // ---- the follow-up itself ----

    if (lead.opted_out) {
      return { leadId: lead.id, temperature: finalTemperature, score, messaged: false, skipped: "lead has opted out" };
    }

    /**
     * WHAT THEY ASKED FOR COMES FIRST.
     *
     * A caller who said "send me the brochure on WhatsApp" gets the brochure,
     * whatever the score says — including on a call the scorer read as cold.
     * The temperature decides whether we reach out uninvited; it has no say
     * over a request the person made out loud.
     */
    const requests = await fulfilCallRequests({
      lead: merged,
      phone,
      signals,
      executionId: input.executionId,
    });

    if (requests) {
      const deliveredKinds = Object.keys(requests.delivered) as AssetKind[];
      const anythingSent = deliveredKinds.length > 0 || requests.locationSent;

      await logActivity({
        leadId: lead.id,
        type: anythingSent ? "call_request_fulfilled" : "call_request_pending",
        channel: "whatsapp",
        description: anythingSent
          ? `Sent what the caller asked for: ${listOut([
              ...deliveredKinds.map((k) => KIND_LABEL[k] ?? k),
              ...(requests.locationSent ? ["the location"] : []),
            ])}.`
          : `Caller asked for ${listOut(
              requests.requested.map((k) => KIND_LABEL[k] ?? k),
            )} — not sent: ${requests.deferred ?? "no approved file of that kind is uploaded"}.`,
        metadata: { executionId: input.executionId, ...requests },
      }).catch(() => {});

      // Anything still outstanding is a person's job, not a silent gap. Only
      // from "none": a thread a colleague has already picked up must not be
      // pushed back to "requested" by an automated follow-up.
      const outstanding =
        requests.unfulfilled.length > 0 || (Boolean(signals.requestedLocation) && !requests.locationSent);
      if (outstanding && (lead.handoff_status ?? "none") === "none") {
        await db()
          .from("villa_leads")
          .update({ handoff_status: "requested", handoff_reason: "post-call material requested" })
          .eq("id", lead.id)
          .then(
            () => undefined,
            () => undefined,
          );
      }

      // We have just messaged them about the thing they asked for. A second,
      // generic "great speaking with you" template on top of that is spam.
      if (anythingSent) {
        return { leadId: lead.id, temperature: finalTemperature, score, messaged: true, requests };
      }
    }

    const templateName = FOLLOW_UP_TEMPLATE[finalTemperature];
    if (!templateName) {
      return {
        leadId: lead.id,
        temperature: finalTemperature,
        score,
        messaged: false,
        skipped: "cold call — recorded, not messaged",
        requests: requests ?? undefined,
      };
    }

    // A template, not free text. The person may never have messaged us on
    // WhatsApp, so there is no open 24-hour window and Meta rejects anything
    // that is not an approved template. sendReengagement renders from the
    // villa_templates registry on Evolution and calls the template API on Meta.
    await sendReengagement(phone, {
      name: templateName,
      language: "en",
      params: [lead.name ?? signals.name ?? "there"],
    });

    await logActivity({
      leadId: lead.id,
      type: "follow_up_sent",
      channel: "whatsapp",
      description: `Post-call WhatsApp follow-up sent (${finalTemperature}).`,
      metadata: { executionId: input.executionId, template: templateName },
    }).catch(() => {});

    return { leadId: lead.id, temperature: finalTemperature, score, messaged: true, requests: requests ?? undefined };
  } catch (e) {
    console.error("[voice-bridge] follow-up failed", e);
    return { ...empty, skipped: e instanceof Error ? e.message : "unknown failure" };
  }
}

/* -------------------------------------------------------------------------- */
/* Missed calls                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The template a missed call earns, when Meta's rules demand one.
 *
 * Deliberately separate from FOLLOW_UP_TEMPLATE: that one thanks somebody for
 * a conversation, and sending it to a person who never picked up reads as a
 * machine talking to itself.
 */
export const MISSED_CALL_TEMPLATE = "call_missed";

/** What we say when nobody picked up. One message, never a series. */
function missedCallText(name: string | null): string {
  const greeting = name ? `Hi ${name}` : "Hi";
  return (
    `${greeting} — this is ${env.salesTeamName ?? "the team"} at Glentree Serenity, Nadergul. ` +
    `We just tried calling you about the project and couldn't reach you.\n\n` +
    `Happy to send the brochure here on WhatsApp, or call back at a time that suits you — ` +
    `just reply and let me know which you'd prefer.`
  );
}

export interface MissedCallResult {
  leadId: string | null;
  messaged: boolean;
  /** Why nothing was sent, when nothing was sent. */
  skipped?: string;
}

/**
 * Run when an outbound call finishes without being answered and will not be
 * retried again.
 *
 * A number that rang out is not a lead that said no — it is a lead we have not
 * reached yet, and WhatsApp is the cheaper second attempt. This opens that
 * door once, on the last attempt only, so a three-attempt campaign produces
 * one message rather than three.
 *
 * Never throws, for the same reason bridgeCallToWhatsApp does not: the call
 * record is already written, and a failed follow-up must not cost it.
 */
export async function notifyMissedCall(input: {
  phone: string | null | undefined;
  name?: string | null;
  executionId: string;
}): Promise<MissedCallResult> {
  const empty: MissedCallResult = { leadId: null, messaged: false };
  const phone = (input.phone ?? "").replace(/[^\d+]/g, "");
  if (!phone) return { ...empty, skipped: "the call carried no phone number" };

  try {
    // Bolna retries any non-2xx, and this runs after the queue entry is
    // already settled, so without this the same person is messaged twice.
    const { data: seen } = await db()
      .from("villa_activities")
      .select("id")
      .eq("activity_type", "missed_call_followup")
      .contains("metadata", { executionId: input.executionId })
      .limit(1);
    if (seen && seen.length > 0) {
      return { ...empty, skipped: "already handled — this is a webhook retry" };
    }

    const lead = await getOrCreateLead({
      phone,
      name: input.name ?? null,
      channel: "voice",
      attribution: { source: "voice_call" },
    });

    // Section 25 again: an opt-out outranks a campaign.
    if (lead.opted_out) {
      return { leadId: lead.id, messaged: false, skipped: "lead has opted out" };
    }

    const body = missedCallText(lead.name ?? input.name ?? null);

    if (activeProvider() === "meta") {
      // They have never messaged us, so there is no open window and Meta will
      // only accept an approved template. sendReengagement renders the
      // registry body on Evolution and calls the template API on Meta.
      await sendReengagement(phone, {
        name: MISSED_CALL_TEMPLATE,
        language: "en",
        params: [lead.name ?? "there"],
      }, body);
    } else {
      await sendPlainText(phone, body);
    }

    await logActivity({
      leadId: lead.id,
      type: "missed_call_followup",
      channel: "whatsapp",
      description: "Called and not answered — WhatsApp follow-up sent.",
      metadata: { executionId: input.executionId },
    }).catch(() => {});

    return { leadId: lead.id, messaged: true };
  } catch (e) {
    console.error("[voice-bridge] missed-call follow-up failed", e);
    return { ...empty, skipped: e instanceof Error ? e.message : "unknown failure" };
  }
}
