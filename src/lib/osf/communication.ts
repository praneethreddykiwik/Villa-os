import { logActivity } from "./activities";
import { configStatus, env } from "./env";
import { db } from "./supabase";
import { messengerPsid } from "./conversation";
import { sendPlainText, sendReengagement } from "./whatsapp/outbound";
import type { Conversation, LeadTemperature, Message, MessageRole } from "./types";

/**
 * The communication centre's data layer.
 *
 * One module behind the unified inbox, the WhatsApp console and the email page.
 * Meta's 24-hour rule is enforced here rather than in a page: hiding the
 * free-text box in the UI is a courtesy, but the API route is what actually has
 * to refuse, because a rejected send costs the customer their reply.
 */

// -----------------------------------------------------------------------------
// Channels and statuses
// -----------------------------------------------------------------------------

/** villa_comm_channel, in the order the enum declares it. */
export const CHANNELS = [
  "whatsapp",
  "instagram",
  "facebook",
  "email",
  "sms",
  "web_form",
  "call",
] as const;

export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABELS: Record<Channel, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  facebook: "Facebook",
  email: "Email",
  sms: "SMS",
  web_form: "Web form",
  call: "Call",
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel as Channel] ?? channel.replace(/_/g, " ");
}

/**
 * villa_conversations.status is free text with a default of 'open' — no enum
 * constrains it. These are the two values the application itself ever writes,
 * so they are the only ones offered as filters.
 */
export const CONVERSATION_STATUSES = ["open", "closed"] as const;

// -----------------------------------------------------------------------------
// Reading threads
// -----------------------------------------------------------------------------

export interface ThreadLead {
  id: string;
  name: string | null;
  phone: string;
  email: string | null;
  lead_temperature: LeadTemperature;
  lead_score: number;
  pipeline_stage: string;
  ai_paused: boolean;
  opted_out: boolean;
  preferred_language: string;
}

export interface MessagePreview {
  role: MessageRole;
  body: string | null;
  media_kind: string | null;
  created_at: string;
}

export interface InboxConversation {
  id: string;
  lead_id: string;
  channel: string;
  status: string;
  started_at: string;
  last_message_at: string;
  message_count: number;
  summary: string | null;
  lead: ThreadLead | null;
  /** Newest message in the thread, for the list preview line. */
  preview: MessagePreview | null;
}

const LEAD_EMBED =
  "lead:villa_leads(id, name, phone, email, lead_temperature, lead_score, pipeline_stage, ai_paused, opted_out, preferred_language)";

/**
 * `preview` is an embedded resource limited to one row *per conversation* —
 * PostgREST applies `limit` on an embed per parent, which is the only way to
 * get a last-message preview for a whole list in a single round-trip.
 */
const CONVERSATION_SELECT = [
  "id, lead_id, channel, status, started_at, last_message_at, message_count, summary",
  LEAD_EMBED,
  "preview:villa_messages(role, body, media_kind, created_at)",
].join(", ");

export interface ConversationFilter {
  channel?: string;
  status?: string;
  limit?: number;
}

export async function listConversations(
  filter: ConversationFilter = {},
): Promise<InboxConversation[]> {
  let query = db().from("villa_conversations").select(CONVERSATION_SELECT);
  if (filter.channel) query = query.eq("channel", filter.channel);
  if (filter.status) query = query.eq("status", filter.status);

  const { data } = await query
    .order("last_message_at", { ascending: false })
    .order("created_at", { referencedTable: "preview", ascending: false })
    .limit(1, { referencedTable: "preview" })
    .limit(filter.limit ?? 80);

  const rows = (data ?? []) as unknown as Array<
    Omit<InboxConversation, "preview"> & { preview: MessagePreview[] | null }
  >;

  return rows.map((row) => ({ ...row, preview: row.preview?.[0] ?? null }));
}

export interface Thread {
  conversation: Conversation;
  lead: ThreadLead | null;
  messages: Message[];
}

/** Null when the id doesn't exist — a stale `?c=` link must not 500 the page. */
export async function loadThread(conversationId: string, limit = 300): Promise<Thread | null> {
  const supabase = db();

  const [{ data: conversation }, { data: messages }] = await Promise.all([
    supabase
      .from("villa_conversations")
      .select(
        `id, lead_id, channel, status, started_at, last_message_at, message_count, summary, ${LEAD_EMBED}`,
      )
      .eq("id", conversationId)
      .maybeSingle(),
    supabase
      .from("villa_messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(limit),
  ]);

  if (!conversation) return null;

  const { lead, ...rest } = conversation as unknown as Conversation & { lead: ThreadLead | null };
  return { conversation: rest as Conversation, lead: lead ?? null, messages: (messages ?? []) as Message[] };
}

export interface InboxFacets {
  total: number;
  byChannel: Record<string, number>;
  byStatus: Record<string, number>;
}

/**
 * Counts for the filter pills.
 *
 * Two columns of at most `cap` rows, tallied in memory. PostgREST has no
 * GROUP BY, and the alternative — one head-count request per channel per
 * status — is eighteen round-trips to render a sidebar.
 */
export async function inboxFacets(cap = 2000): Promise<InboxFacets> {
  const { data } = await db().from("villa_conversations").select("channel, status").limit(cap);
  const rows = (data ?? []) as Array<{ channel: string; status: string }>;

  const facets: InboxFacets = { total: rows.length, byChannel: {}, byStatus: {} };
  for (const row of rows) {
    facets.byChannel[row.channel] = (facets.byChannel[row.channel] ?? 0) + 1;
    facets.byStatus[row.status] = (facets.byStatus[row.status] ?? 0) + 1;
  }
  return facets;
}

// -----------------------------------------------------------------------------
// Meta's 24-hour customer-service window
// -----------------------------------------------------------------------------

export const SERVICE_WINDOW_HOURS = 24;

export interface ServiceWindow {
  /** The customer's most recent inbound message, or null if they never wrote. */
  lastInboundAt: string | null;
  /** Null when there has been no inbound message at all. */
  hoursSince: number | null;
  /** True only while free-form text is permitted. */
  open: boolean;
  /** Whole minutes of free-text time left; null once the window is shut. */
  minutesLeft: number | null;
}

/**
 * Meta only allows a free-form message within 24 hours of the customer's last
 * inbound one. Outside that, the sole legal outbound is an approved template.
 * A conversation that has never received an inbound message is *never* open —
 * an outbound-first thread has no window to be inside.
 */
export function serviceWindow(lastInboundAt: string | null, now = Date.now()): ServiceWindow {
  if (!lastInboundAt) {
    return { lastInboundAt: null, hoursSince: null, open: false, minutesLeft: null };
  }

  const at = new Date(lastInboundAt).getTime();
  if (Number.isNaN(at)) {
    return { lastInboundAt, hoursSince: null, open: false, minutesLeft: null };
  }

  const elapsedMs = now - at;
  const remainingMs = SERVICE_WINDOW_HOURS * 3_600_000 - elapsedMs;
  const open = remainingMs > 0;

  return {
    lastInboundAt,
    hoursSince: elapsedMs / 3_600_000,
    open,
    minutesLeft: open ? Math.floor(remainingMs / 60_000) : null,
  };
}

/** "3h 12m left" / "closed 5h ago" — the phrasing the console shows a rep. */
export function windowLabel(window: ServiceWindow): string {
  if (window.hoursSince === null) return "No inbound message yet";
  if (window.open && window.minutesLeft !== null) {
    const hours = Math.floor(window.minutesLeft / 60);
    const minutes = window.minutesLeft % 60;
    return hours > 0 ? `${hours}h ${minutes}m left` : `${minutes}m left`;
  }
  const closedFor = window.hoursSince - SERVICE_WINDOW_HOURS;
  return closedFor >= 24
    ? `Closed ${Math.floor(closedFor / 24)}d ago`
    : `Closed ${Math.max(0, Math.floor(closedFor))}h ago`;
}

export function lastInboundFrom(
  messages: Array<Pick<Message, "role" | "created_at">>,
): string | null {
  let latest: string | null = null;
  for (const message of messages) {
    if (message.role !== "customer") continue;
    if (!latest || message.created_at > latest) latest = message.created_at;
  }
  return latest;
}

async function lastInboundAt(conversationId: string): Promise<string | null> {
  const { data } = await db()
    .from("villa_messages")
    .select("created_at")
    .eq("conversation_id", conversationId)
    .eq("role", "customer")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { created_at: string } | null)?.created_at ?? null;
}

// -----------------------------------------------------------------------------
// Sending
// -----------------------------------------------------------------------------

export type SendResult = { ok: true; messageId: string | null } | { ok: false; error: string };
export type WriteResult = { ok: true } | { ok: false; error: string };

export const WHATSAPP_ENV_VARS = [
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_APP_SECRET",
];

/**
 * What an Evolution deployment needs instead.
 *
 * Only the three send credentials. EVOLUTION_WEBHOOK_TOKEN is deliberately
 * absent: this console does not receive inbound — the agent that owns the
 * number does — so listing it here would ask somebody to configure a webhook
 * we refuse on purpose.
 */
export const EVOLUTION_ENV_VARS = [
  "EVOLUTION_API_URL",
  "EVOLUTION_API_KEY",
  "EVOLUTION_INSTANCE",
];

/**
 * Whether the transport that would actually carry this message is configured.
 *
 * `sendPlainText` already routes by `whatsappProvider`, so asking only about
 * the Meta variables refused every send on an Evolution deployment that was
 * correctly set up — the message never left, and the rep was told to configure
 * credentials the send path was never going to use.
 */
function sendTransportReady(channel = "whatsapp"): { ok: true } | { ok: false; error: string } {
  const status = configStatus();

  // Each channel is its own transport with its own credentials. Judging an
  // Instagram reply by whether Evolution is connected gets it wrong in both
  // directions: it lets an unconfigured Instagram send through to fail deep in
  // the Graph call, and it refuses a perfectly good one on a deployment that
  // simply has no WhatsApp.
  if (channel === "instagram") {
    return status.instagram
      ? { ok: true }
      : {
          ok: false,
          error:
            "Instagram isn't connected. Set INSTAGRAM_ACCOUNT_ID and INSTAGRAM_ACCESS_TOKEN before sending.",
        };
  }
  if (channel === "facebook") {
    return status.messenger
      ? { ok: true }
      : {
          ok: false,
          error:
            "Messenger isn't connected. Set MESSENGER_PAGE_ID and MESSENGER_ACCESS_TOKEN before sending.",
        };
  }

  if (env.whatsappProvider === "evolution") {
    return status.evolution
      ? { ok: true }
      : {
          ok: false,
          error:
            "WhatsApp isn't connected. Set EVOLUTION_API_URL, EVOLUTION_API_KEY and EVOLUTION_INSTANCE before sending.",
        };
  }
  return status.whatsapp
    ? { ok: true }
    : {
        ok: false,
        error: "WhatsApp isn't connected. Set the WHATSAPP_* variables in .env.local before sending.",
      };
}

export const OUTSIDE_WINDOW_MESSAGE =
  "The 24-hour customer-service window has closed. Meta rejects free-form text here — " +
  "send an approved template to re-open the conversation.";

/**
 * Whether Meta's 24-hour rule applies to this deployment at all.
 *
 * It is Meta's rule, not WhatsApp's. Evolution drives a linked handset and has
 * no service window and no template approval, so enforcing it there did real
 * damage in both directions: the composer counted down to a deadline that did
 * not exist, and once it expired the send was REFUSED outright — a rep with a
 * customer who had gone quiet for a day could not reply at all, and was told
 * to send an approved template that Evolution has no concept of.
 *
 * Skipping the check also removes a database round trip from every send on
 * Evolution, because `lastInboundAt` no longer has to be fetched.
 */
export function serviceWindowApplies(): boolean {
  return env.whatsappProvider === "meta";
}

/**
 * Channels a human can reply on from this console, and what each one costs.
 *
 * `window` is whether Meta's 24-hour service rule binds. For WhatsApp it
 * depends on the transport — Evolution drives a linked handset and has no such
 * rule. Instagram and Messenger are always Meta's own surface, so the window
 * applies there whatever WHATSAPP_PROVIDER happens to say; reading the
 * WhatsApp provider to decide an Instagram send would let an Evolution
 * deployment post a Page DM a week late and be refused by Meta at the edge.
 *
 * `limit` is the transport's own cap, so the composer refuses over-length text
 * here rather than having Meta truncate it silently at the far end.
 */
const REPLYABLE: Record<string, { label: string; window: () => boolean; limit: number }> = {
  whatsapp: { label: "WhatsApp", window: serviceWindowApplies, limit: 4096 },
  instagram: { label: "Instagram", window: () => true, limit: 1000 },
  facebook: { label: "Messenger", window: () => true, limit: 2000 },
};

export function replyableChannels(): string[] {
  return Object.keys(REPLYABLE);
}

/** Whether Meta's 24-hour rule binds on this particular thread. */
export function windowAppliesTo(channel: string): boolean {
  return REPLYABLE[channel]?.window() ?? serviceWindowApplies();
}

/** The transport's own character cap, for the composer's counter. */
export function channelTextLimit(channel: string): number {
  return REPLYABLE[channel]?.limit ?? 4096;
}

export function canReplyOn(channel: string): boolean {
  return Object.prototype.hasOwnProperty.call(REPLYABLE, channel);
}

interface SendTarget {
  conversation: Pick<Conversation, "id" | "message_count" | "channel">;
  lead: Pick<ThreadLead, "id" | "phone" | "opted_out" | "name"> & {
    instagram_id?: string | null;
  };
}

async function loadTarget(conversationId: string): Promise<SendTarget | { error: string }> {
  const { data } = await db()
    .from("villa_conversations")
    .select("id, message_count, channel, lead:villa_leads(id, phone, opted_out, name, instagram_id)")
    .eq("id", conversationId)
    .maybeSingle();

  if (!data) return { error: "That conversation no longer exists." };

  const row = data as unknown as {
    id: string;
    message_count: number;
    channel: string;
    lead: SendTarget["lead"] | null;
  };

  if (!row.lead) {
    return { error: "This conversation has no lead attached, so there is nobody to reply to." };
  }
  if (!canReplyOn(row.channel)) {
    return {
      error:
        `This is a ${channelLabel(row.channel)} thread. Replies can be sent from here on ` +
        `${replyableChannels().map(channelLabel).join(", ")}.`,
    };
  }

  return {
    conversation: { id: row.id, message_count: row.message_count, channel: row.channel },
    lead: row.lead,
  };
}

/**
 * Writes what we just sent into the thread and hands the conversation to the
 * human who sent it.
 *
 * Pausing the AI is part of sending rather than a separate button: the agent
 * replying on top of a rep is the failure mode this whole console exists to
 * prevent, and a rep should not have to remember a second click to avoid it.
 */
async function recordOutbound(params: {
  target: SendTarget;
  body: string;
  waMessageId: string | null;
  activityDescription: string;
}): Promise<void> {
  const supabase = db();
  const now = new Date().toISOString();

  /**
   * All four writes go at once.
   *
   * They were sequential, which cost four round trips to a database roughly
   * 150ms away — about half a second the rep spent watching a spinner AFTER
   * the customer had already received the message. Nothing here reads anything
   * another one writes: a message row, a conversation timestamp, the lead's
   * pause flag and an activity line are four independent facts about the same
   * event, so the ordering was incidental rather than meaningful.
   *
   * `allSettled`, not `all`: the send already happened. A failed bookkeeping
   * write must not surface as a send failure, because a rep told "that didn't
   * send" will send again and the customer gets the message twice.
   */
  const [inserted] = await Promise.allSettled([
    supabase.from("villa_messages").insert({
      conversation_id: params.target.conversation.id,
      lead_id: params.target.lead.id,
      role: "human_agent",
      channel: "whatsapp",
      body: params.body,
      wa_message_id: params.waMessageId,
    }),

    supabase
      .from("villa_conversations")
      .update({ last_message_at: now, message_count: params.target.conversation.message_count + 1 })
      .eq("id", params.target.conversation.id),

    supabase
      .from("villa_leads")
      .update({ ai_paused: true, last_contact_at: now })
      .eq("id", params.target.lead.id),

    logActivity({
      leadId: params.target.lead.id,
      type: "message_sent",
      description: params.activityDescription,
      channel: "whatsapp",
      metadata: { conversation_id: params.target.conversation.id, sent_by: "human" },
    }),
  ]);

  // The message row is the one worth complaining about in the log: without it
  // the rep's own reply is missing from the thread they are looking at.
  if (inserted.status === "rejected") {
    console.error("[communication] could not record outbound message:", inserted.reason);
  } else if (inserted.value?.error) {
    console.error("[communication] could not record outbound message:", inserted.value.error.message);
  }
}

export async function sendWhatsAppText(input: {
  conversationId: string;
  text: string;
}): Promise<SendResult> {
  const body = input.text?.trim();
  if (!body) return { ok: false, error: "Type a message before sending." };

  const target = await loadTarget(input.conversationId);
  if ("error" in target) return { ok: false, error: target.error };
  if (target.lead.opted_out) {
    return { ok: false, error: "This customer opted out. Nothing may be sent to them." };
  }

  // After loadTarget, not before: which credentials have to be present depends
  // on the thread's channel, and that is not known until the thread is read.
  const ready = sendTransportReady(target.conversation.channel);
  if (!ready.ok) return { ok: false, error: ready.error };

  // Length is the transport's rule, not one global number: Instagram stops at
  // 1000 characters where WhatsApp allows 4096.
  const rules = REPLYABLE[target.conversation.channel]!;
  if (body.length > rules.limit) {
    return {
      ok: false,
      error: `${rules.label} caps a text message at ${rules.limit} characters.`,
    };
  }

  // Re-checked server-side: the UI hides the box, but a stale tab still has it.
  // Skipped on Evolution, where the window does not exist and the lookup it
  // needs is a round trip — see REPLYABLE.
  if (rules.window() && !serviceWindow(await lastInboundAt(input.conversationId)).open) {
    return { ok: false, error: OUTSIDE_WINDOW_MESSAGE };
  }

  let messageId: string | null = null;
  try {
    // The thread decides the transport, not whichever identifier happens to be
    // populated. One person can reach us on WhatsApp and on Instagram and end
    // up with both a phone and an IGSID on the same lead; answering their
    // Instagram DM over WhatsApp because a phone number exists would be a
    // reply in the wrong window, to a channel they did not use.
    if (target.conversation.channel === "facebook") {
      const psid = messengerPsid(target.lead.instagram_id);
      if (!psid) return { ok: false, error: "This Messenger thread has no sender id to reply to." };
      const { sendMessengerText } = await import("./messenger/client");
      ({ messageId } = await sendMessengerText(psid, body));
    } else if (target.conversation.channel === "instagram") {
      if (!target.lead.instagram_id) {
        return { ok: false, error: "This Instagram thread has no sender id to reply to." };
      }
      const { sendInstagramText } = await import("./instagram/client");
      ({ messageId } = await sendInstagramText(target.lead.instagram_id, body));
    } else if (target.lead.phone) {
      ({ messageId } = await sendPlainText(target.lead.phone, body));
    } else {
      return { ok: false, error: "This lead has no phone number to send to." };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Send failed." };
  }

  await recordOutbound({
    target,
    body,
    waMessageId: messageId,
    activityDescription: "Rep replied on WhatsApp",
  });
  return { ok: true, messageId };
}

/** Meta's rule: lowercase letters, digits and underscores only. */
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const LANGUAGE_CODE = /^[a-z]{2,3}(_[A-Z]{2})?$/;

export async function sendWhatsAppTemplate(input: {
  conversationId: string;
  templateName: string;
  language?: string | null;
  params?: string[];
}): Promise<SendResult> {
  const ready = sendTransportReady();
  if (!ready.ok) return { ok: false, error: ready.error };

  const name = input.templateName?.trim().toLowerCase();
  if (!name) return { ok: false, error: "A template name is required." };
  if (!TEMPLATE_NAME.test(name)) {
    return {
      ok: false,
      error: `"${input.templateName}" isn't a valid template name — Meta allows lowercase letters, digits and underscores.`,
    };
  }

  const language = input.language?.trim() || "en";
  if (!LANGUAGE_CODE.test(language)) {
    return { ok: false, error: `"${language}" isn't a language code. Use en, en_US, hi, te.` };
  }

  const target = await loadTarget(input.conversationId);
  if ("error" in target) return { ok: false, error: target.error };
  if (target.lead.opted_out) {
    return { ok: false, error: "This customer opted out. Nothing may be sent to them." };
  }

  // loadTarget now admits Instagram and Messenger threads, which the free-text
  // path can serve. Templates are a WhatsApp Business feature and have no
  // counterpart on either, so a stale tab posting this form at one of them
  // must be refused here rather than sending a WhatsApp template to a lead
  // whose `phone` is null.
  if (target.conversation.channel !== "whatsapp") {
    return {
      ok: false,
      error: `${channelLabel(target.conversation.channel)} has no message templates. Only WhatsApp threads can be re-opened this way.`,
    };
  }

  let messageId: string | null = null;
  try {
    ({ messageId } = await sendReengagement(target.lead.phone, {
      name,
      language,
      params: input.params ?? [],
    }));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "WhatsApp send failed." };
  }

  // The rendered body lives in Meta's template library, not here, so the thread
  // records which template went out rather than inventing the text it contained.
  await recordOutbound({
    target,
    body: `[template: ${name}]${input.params?.length ? ` ${input.params.join(" · ")}` : ""}`,
    waMessageId: messageId,
    activityDescription: `Rep sent WhatsApp template "${name}"`,
  });
  return { ok: true, messageId };
}

export async function setAiPaused(leadId: string, paused: boolean): Promise<WriteResult> {
  if (!leadId) return { ok: false, error: "A lead is required." };

  const { error } = await db().from("villa_leads").update({ ai_paused: paused }).eq("id", leadId);
  if (error) return { ok: false, error: error.message };

  await logActivity({
    leadId,
    type: "note",
    description: paused ? "AI paused — a human owns this thread" : "AI resumed on this thread",
    channel: "whatsapp",
  });
  return { ok: true };
}

// -----------------------------------------------------------------------------
// Email
// -----------------------------------------------------------------------------

export interface EmailLead {
  id: string;
  name: string | null;
  email: string;
  phone: string;
  lead_temperature: LeadTemperature;
  lead_score: number;
  pipeline_stage: string;
  source: string;
  campaign: string | null;
  opted_out: boolean;
  last_contact_at: string;
}

/**
 * Leads that could be emailed at all.
 *
 * Blank strings are dropped in memory rather than with a `.neq` filter so the
 * intent stays legible: an empty email is the same as no email.
 */
export async function leadsWithEmail(limit = 200): Promise<EmailLead[]> {
  const { data } = await db()
    .from("villa_leads")
    .select(
      "id, name, email, phone, lead_temperature, lead_score, pipeline_stage, source, campaign, opted_out, last_contact_at",
    )
    .not("email", "is", null)
    .order("last_contact_at", { ascending: false })
    .limit(limit);

  return ((data ?? []) as unknown as EmailLead[]).filter((lead) => lead.email.trim() !== "");
}
