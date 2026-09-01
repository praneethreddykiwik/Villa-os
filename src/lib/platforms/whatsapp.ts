import { DRIVER, graphVersion, type PlatformAdapter } from "./types";

/**
 * WHATSAPP CLOUD API
 *
 * WhatsApp is not a publishing channel — you cannot post to a feed. It is a
 * conversation channel, and it has one rule that dominates every integration:
 *
 *   **The 24-hour customer service window.** You may send free-form messages
 *   only within 24 hours of the customer's last message. Outside that window,
 *   the only thing that delivers is a pre-approved *template*. Getting this
 *   wrong is the single most common reason WhatsApp integrations silently fail,
 *   so `sendMessage` enforces it rather than letting Meta reject the call.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface WhatsAppMessage {
  id: string;
  from: string;
  name?: string;
  text: string;
  timestamp: string;
  type: "text" | "image" | "audio" | "document" | "interactive";
  /** Media messages carry an id that must be downloaded separately. */
  mediaId?: string;
  filename?: string;
}

export function isWithinServiceWindow(lastInboundAt?: string): boolean {
  if (!lastInboundAt) return false;
  return Date.now() - new Date(lastInboundAt).getTime() < WINDOW_MS;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  /** True when we refused because the free-form window had closed. */
  requiresTemplate?: boolean;
}

export async function sendWhatsApp(opts: {
  phoneNumberId: string;
  token: string;
  to: string;
  text?: string;
  /** Approved template name; required outside the 24h window. */
  template?: { name: string; language: string; params?: string[] };
  lastInboundAt?: string;
}): Promise<SendResult> {
  const inWindow = isWithinServiceWindow(opts.lastInboundAt);

  if (!inWindow && !opts.template) {
    return {
      ok: false,
      requiresTemplate: true,
      error: "Outside the 24-hour service window — send an approved template instead of free text.",
    };
  }

  if (DRIVER === "mock") {
    return { ok: true, messageId: `wamid.mock${Math.random().toString(36).slice(2, 10)}` };
  }

  const body = opts.template
    ? {
        messaging_product: "whatsapp",
        to: opts.to,
        type: "template",
        template: {
          name: opts.template.name,
          language: { code: opts.template.language },
          ...(opts.template.params?.length
            ? { components: [{ type: "body", parameters: opts.template.params.map((t) => ({ type: "text", text: t })) }] }
            : {}),
        },
      }
    : { messaging_product: "whatsapp", to: opts.to, type: "text", text: { preview_url: false, body: opts.text ?? "" } };

  try {
    const res = await fetch(`https://graph.facebook.com/${graphVersion()}/${opts.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { messages?: Array<{ id: string }>; error?: { message: string } };
    if (!res.ok) return { ok: false, error: json.error?.message ?? `WhatsApp ${res.status}` };
    return { ok: true, messageId: json.messages?.[0]?.id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Normalise an inbound webhook payload.
 *
 * Meta nests this four levels deep and delivers status callbacks (sent/read)
 * through the same endpoint as real messages, so the filter matters: without it
 * every delivery receipt would appear in the inbox as an empty conversation.
 */
export function parseWebhook(payload: unknown): WhatsAppMessage[] {
  const out: WhatsAppMessage[] = [];
  const body = payload as {
    entry?: Array<{
      changes?: Array<{
        value?: {
          contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
          messages?: Array<{
            id: string;
            from: string;
            timestamp: string;
            type: string;
            text?: { body: string };
            interactive?: { button_reply?: { title: string }; list_reply?: { title: string } };
            image?: { id: string };
            document?: { id: string; filename?: string };
            audio?: { id: string };
          }>;
        };
      }>;
    }>;
  };

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value?.messages) continue; // status callbacks arrive here too — ignore them
      for (const m of value.messages) {
        const contact = value.contacts?.find((c) => c.wa_id === m.from);
        out.push({
          id: m.id,
          from: m.from,
          name: contact?.profile?.name,
          text:
            m.text?.body ??
            m.interactive?.button_reply?.title ??
            m.interactive?.list_reply?.title ??
            `[${m.type}]`,
          timestamp: new Date(Number(m.timestamp) * 1000).toISOString(),
          type: (m.type as WhatsAppMessage["type"]) ?? "text",
          mediaId: m.image?.id ?? m.document?.id ?? m.audio?.id,
          filename: m.document?.filename,
        });
      }
    }
  }
  return out;
}

/**
 * WhatsApp appears in the channel registry so it shows up in Connections and
 * the Engagement inbox, but publishing is intentionally rejected — there is no
 * feed to post to, and pretending otherwise would produce a broken UI affordance.
 */
export const whatsapp: PlatformAdapter = {
  channel: "whatsapp",
  label: "WhatsApp",
  color: "#25D366",
  capabilities: {
    formats: [],
    captionLimit: 4096,
    hashtagLimit: 0,
    maxMedia: 1,
    supportsStories: false,
    supportsFirstComment: false,
    supportsNativeScheduling: false,
    supportsStickers: false,
    videoMaxSec: {},
    aspectRatios: {},
  },
  validate: () => ["WhatsApp is a conversation channel — reply from the Engagement inbox, not the composer."],
  publish: async () => ({
    ok: false,
    error: "WhatsApp has no feed to publish to. Use the Engagement inbox or a template broadcast.",
    retryable: false,
  }),
  rateLimit: async () => ({ used: 0, quota: 1000, windowHours: 24 }),
};
