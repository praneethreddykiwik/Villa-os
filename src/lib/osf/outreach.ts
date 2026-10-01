import { db } from "./supabase";
import { env } from "./env";
import { logActivity } from "./activities";
import { canonicalPhone, getOrCreateConversation, getOrCreateLead } from "./conversation";
import { sendPlainText } from "./whatsapp/outbound";

/**
 * STARTING A CONVERSATION FROM A LIST OF NUMBERS.
 *
 * The desk has numbers — from a property portal, a walk-in register, an ad
 * form — and wants the first message sent so the AI agent can take the
 * conversation from there. This is that first message and nothing more.
 *
 * WHY THIS IS PACED AND CAPPED RATHER THAN A BULK BLAST
 *
 * Every message here goes to somebody who has not written to us. On the
 * official Cloud API that requires a pre-approved template, precisely because
 * unsolicited outbound is what spam looks like. This deployment sends through
 * Evolution, which drives a linked handset and enforces none of that — so the
 * only thing standing between a careless paste and WhatsApp banning the number
 * is this module.
 *
 * Losing the number is not a degraded feature. It takes every conversation and
 * every customer's history with it. So: a hard cap per run, a real pause
 * between sends, and each recipient sent individually so one failure never
 * takes the rest down.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not pause the AI. A human reply pauses the agent because a person has
 * taken the thread over; an opener is the opposite — the whole point is that
 * the agent picks the conversation up when they answer.
 */

/** One run. Small on purpose — see the module note. */
export const MAX_RECIPIENTS = 25;

/** Gap between sends. Bursts are the pattern spam filters look for. */
export const SEND_SPACING_MS = 4_000;

export interface Recipient {
  /** Digits only, country code included, exactly as WhatsApp stores it. */
  phone: string;
  name: string | null;
}

export interface ParsedRecipients {
  recipients: Recipient[];
  /** Rejected lines, each with a reason a person can act on. */
  rejected: { line: string; reason: string }[];
}

/**
 * Reads the pasted block.
 *
 * One recipient per line, number first, anything after it treated as the name:
 *
 *   919876543210, Koushik S
 *   919812345678 Priya
 *   +91 98765 43211
 *
 * Lenient about how the number is written and strict about what it resolves
 * to, because the cost of a typo here is a message to a stranger.
 */
export function parseRecipients(raw: string): ParsedRecipients {
  const recipients: Recipient[] = [];
  const rejected: { line: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const rawLine of (raw ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // Split the number from the name: the leading run of digits, spaces,
    // dashes and brackets is the number; the remainder is what to call them.
    const match = /^\s*(\+?[\d\s()\-.]{8,})\s*(?:[,|–—-]\s*)?(.*)$/.exec(line);
    if (!match) {
      rejected.push({ line, reason: "no phone number found on this line" });
      continue;
    }

    const digits = match[1].replace(/\D/g, "");
    const name = match[2].trim().replace(/\s+/g, " ").slice(0, 80) || null;

    if (digits.length < 10 || digits.length > 15) {
      rejected.push({ line, reason: "not a valid international number" });
      continue;
    }
    // Ten digits with no country code is an Indian mobile missing its 91.
    // Guessing is how a message reaches a completely different country, so it
    // is refused rather than assumed.
    if (digits.length === 10) {
      rejected.push({ line, reason: "needs a country code, e.g. 91 in front" });
      continue;
    }
    if (seen.has(digits)) {
      rejected.push({ line, reason: "already listed above" });
      continue;
    }

    seen.add(digits);
    recipients.push({ phone: digits, name });
  }

  return { recipients, rejected };
}

/**
 * Fills `{name}` in the opener.
 *
 * The fallback matters more than it looks: "Hi ," reads as a broken mail merge
 * and tells the reader immediately that nobody wrote this to them.
 */
export function renderOpener(template: string, name: string | null): string {
  const greeting = name?.trim() || "there";
  return template.replace(/\{name\}/gi, greeting).trim();
}

/**
 * Checks a parsed list against the database WITHOUT sending anything.
 *
 * startConversations refuses two kinds of recipient — someone who opted out,
 * and someone who already has a thread — but it only discovers them one at a
 * time, mid-run. Preview used to skip this entirely, so it would promise
 * "Message 1 person" and the send would then quietly skip that person and
 * report nothing sent. The preview exists precisely so that surprise cannot
 * happen, so it has to ask the same questions the send will ask.
 *
 * Never throws: a database hiccup must degrade the preview to "cannot tell",
 * not block the desk from sending.
 */
export async function screenRecipients(recipients: Recipient[]): Promise<{
  sendable: Recipient[];
  blocked: { phone: string; name: string | null; reason: string }[];
}> {
  const blocked: { phone: string; name: string | null; reason: string }[] = [];
  if (recipients.length === 0) return { sendable: [], blocked };

  try {
    const supabase = db();
    // Match the spelling leads are stored in. parseRecipients already strips
    // to digits, but a lead written before canonicalPhone existed may still
    // carry a leading +, so compare on the canonical form of both sides.
    const phones = recipients.map((r) => canonicalPhone(r.phone));
    const { data: leads } = await supabase
      .from("villa_leads")
      .select("id, phone, opted_out")
      .in("phone", phones);

    if (!leads || leads.length === 0) return { sendable: recipients, blocked };

    const { data: conversations } = await supabase
      .from("villa_conversations")
      .select("lead_id, message_count")
      .eq("channel", "whatsapp")
      .in("lead_id", leads.map((l) => l.id));

    const talkedTo = new Set(
      (conversations ?? []).filter((c) => (c.message_count ?? 0) > 0).map((c) => c.lead_id),
    );
    const byPhone = new Map(leads.map((l) => [canonicalPhone(l.phone), l]));

    const sendable = recipients.filter((r) => {
      const lead = byPhone.get(canonicalPhone(r.phone));
      if (!lead) return true;
      if (lead.opted_out) {
        blocked.push({ ...r, reason: "opted out — nothing may be sent to them" });
        return false;
      }
      if (talkedTo.has(lead.id)) {
        blocked.push({ ...r, reason: "already has a WhatsApp thread — open it in the inbox instead" });
        return false;
      }
      return true;
    });

    return { sendable, blocked };
  } catch {
    // Let the send be the judge rather than blocking on a read failure.
    return { sendable: recipients, blocked };
  }
}

export type OutreachOutcome =
  | { phone: string; name: string | null; status: "sent"; leadId: string; conversationId: string }
  | { phone: string; name: string | null; status: "skipped" | "failed"; reason: string };

export interface OutreachResult {
  sent: number;
  skipped: number;
  failed: number;
  outcomes: OutreachOutcome[];
}

/**
 * Sends the opener to each recipient, in order, with a gap between them.
 *
 * Never throws: one bad number must not abandon the rest of the list, and the
 * caller needs to know exactly who was reached and who was not.
 */
export async function startConversations(input: {
  recipients: Recipient[];
  template: string;
  /** Who pressed the button — recorded on the lead's timeline. */
  actor: string;
  /** Overridable so tests do not sit through the real pacing. */
  spacingMs?: number;
}): Promise<OutreachResult> {
  const outcomes: OutreachOutcome[] = [];
  const spacing = input.spacingMs ?? SEND_SPACING_MS;
  const supabase = db();

  for (const [index, person] of input.recipients.entries()) {
    if (index > 0 && spacing > 0) {
      await new Promise((resolve) => setTimeout(resolve, spacing));
    }

    try {
      const lead = await getOrCreateLead({
        phone: person.phone,
        name: person.name,
        channel: "whatsapp",
        attribution: { source: "outreach" },
      });

      // Section 25 of every messaging rule worth following, and the law in
      // several places: an opt-out is absolute and is not undone by somebody
      // pasting the number into a new list.
      if (lead.opted_out) {
        outcomes.push({ ...person, status: "skipped", reason: "this person opted out" });
        continue;
      }

      const conversation = await getOrCreateConversation(lead.id, "whatsapp");

      // An opener is for somebody we have never spoken to. Dropping one into a
      // live thread — mid-negotiation, or straight after the agent answered a
      // question — reads as a bot that has forgotten the conversation.
      if ((conversation.message_count ?? 0) > 0) {
        outcomes.push({
          ...person,
          status: "skipped",
          reason: "already has a conversation — open it in the inbox instead",
        });
        continue;
      }

      const body = renderOpener(input.template, person.name);
      const { messageId } = await sendPlainText(person.phone, body);

      // Written after the send, and never allowed to fail the send: the
      // customer has the message either way, and reporting a failure here
      // would invite somebody to send it a second time.
      await Promise.allSettled([
        supabase.from("villa_messages").insert({
          conversation_id: conversation.id,
          lead_id: lead.id,
          role: "human_agent",
          channel: "whatsapp",
          body,
          wa_message_id: messageId,
        }),
        supabase
          .from("villa_conversations")
          .update({ last_message_at: new Date().toISOString(), message_count: 1 })
          .eq("id", conversation.id),
        // `ai_paused` is deliberately untouched — see the module note. The
        // agent is meant to answer when they reply; that is the whole point.
        supabase
          .from("villa_leads")
          .update({ last_contact_at: new Date().toISOString() })
          .eq("id", lead.id),
        logActivity({
          leadId: lead.id,
          type: "outreach_sent",
          channel: "whatsapp",
          actorName: input.actor,
          description: `Opening message sent to ${person.name ?? person.phone}.`,
          metadata: { conversation_id: conversation.id, sent_by: "human", provider: env.whatsappProvider },
        }),
      ]);

      outcomes.push({
        ...person,
        status: "sent",
        leadId: lead.id,
        conversationId: conversation.id,
      });
    } catch (e) {
      outcomes.push({
        ...person,
        status: "failed",
        reason: e instanceof Error ? e.message : "the message could not be sent",
      });
    }
  }

  return {
    sent: outcomes.filter((o) => o.status === "sent").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
    outcomes,
  };
}
