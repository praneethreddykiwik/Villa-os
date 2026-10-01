/**
 * Facebook Messenger transport.
 *
 * Messenger and Instagram Direct are the same Graph API surface with a
 * different id on the front: POST /{page-id}/messages with a recipient of
 * {id: <PSID>}. The shapes below mirror src/lib/osf/instagram/client.ts on
 * purpose — divergence between two transports that Meta treats as one is how
 * a fix lands on a single channel.
 *
 * Outbound only. Nothing here decides *whether* to send; that is the caller's
 * job, and for agent replies it is gated by src/lib/osf/autoreply.ts.
 */
import { env } from "../env";
import type { AgentReply } from "../types";

/**
 * Messenger truncates a text message at 2000 characters, and silently — the
 * send succeeds and the customer sees a sentence stop mid-word. Split instead.
 */
/**
 * The channel value Messenger writes to the database.
 *
 * villa_comm_channel is a Postgres enum and its Messenger member is spelled
 * `facebook` — there is no `messenger`. Writing the transport's own name would
 * throw on the enum for every single DM, so the name is pinned here once and
 * imported rather than retyped at each insert.
 */
export const MESSENGER_CHANNEL = "facebook" as const;

const TEXT_LIMIT = 2000;
const QUICK_REPLY_LIMIT = 13;
const QUICK_REPLY_TITLE_LIMIT = 20;

function endpoint(): string {
  const version = env.whatsappApiVersion;
  const page = env.messengerPageId;
  if (!/^\d+$/.test(page)) {
    throw new Error("MESSENGER_PAGE_ID must be the numeric Facebook Page id");
  }
  return `https://graph.facebook.com/${version}/${page}/messages`;
}

async function send(payload: Record<string, unknown>): Promise<{ messageId: string | null }> {
  const response = await fetch(endpoint(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.messengerAccessToken}`,
    },
    body: JSON.stringify({ messaging_type: "RESPONSE", ...payload }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    // The Page id and the token are both in scope here; neither goes in the
    // message. The status and Meta's own error body are what a human needs.
    throw new Error(`Messenger send failed (${response.status}): ${detail.slice(0, 300)}`);
  }

  const json = (await response.json()) as { message_id?: string };
  return { messageId: json.message_id ?? null };
}

/** Splits on a paragraph or sentence boundary rather than mid-word. */
export function splitForMessenger(body: string, limit = TEXT_LIMIT): string[] {
  if (body.length <= limit) return [body];
  const parts: string[] = [];
  let rest = body;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(". "));
    const at = cut > limit * 0.5 ? cut + 1 : limit;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

export async function sendMessengerText(to: string, body: string): Promise<{ messageId: string | null }> {
  // A long reply goes out as several messages; the id of the last one is what
  // the thread records, so the stored row points at what the customer saw last.
  let last: { messageId: string | null } = { messageId: null };
  for (const chunk of splitForMessenger(body)) {
    last = await send({ recipient: { id: to }, message: { text: chunk } });
  }
  return last;
}

export async function sendMessengerMedia(to: string, url: string, kind: string): Promise<{ messageId: string | null }> {
  const type = kind === "video" || kind === "virtual_tour" ? "video" : "image";
  return send({
    recipient: { id: to },
    message: { attachment: { type, payload: { url, is_reusable: true } } },
  });
}

export async function sendMessengerDocument(to: string, url: string): Promise<{ messageId: string | null }> {
  return send({
    recipient: { id: to },
    message: { attachment: { type: "file", payload: { url, is_reusable: true } } },
  });
}

export async function sendMessengerQuickReplies(
  to: string,
  body: string,
  options: Array<{ id: string; title: string }>,
): Promise<{ messageId: string | null }> {
  return send({
    recipient: { id: to },
    message: {
      text: body.slice(0, TEXT_LIMIT),
      quick_replies: options.slice(0, QUICK_REPLY_LIMIT).map((o) => ({
        content_type: "text",
        title: o.title.slice(0, QUICK_REPLY_TITLE_LIMIT),
        payload: o.id,
      })),
    },
  });
}

/**
 * Renders one agent turn onto Messenger.
 *
 * Mirrors deliverToInstagram: when there are more options than Messenger will
 * carry as chips, they go out as a numbered list instead of being silently
 * truncated to the first thirteen.
 */
export async function deliverToMessenger(to: string, reply: AgentReply): Promise<void> {
  if (reply.options?.length) {
    const body = reply.text ?? "Please choose:";
    if (reply.options.length <= QUICK_REPLY_LIMIT) {
      await sendMessengerQuickReplies(to, body, reply.options);
    } else {
      const numbered = reply.options.map((o, i) => `${i + 1}. ${o.title}`).join("\n");
      await sendMessengerText(to, `${body}\n\n${numbered}`);
    }
    return;
  }

  if (reply.mediaUrl && reply.mediaKind) {
    // Unlike Instagram Direct, Messenger carries real file attachments, so a
    // brochure arrives as a PDF rather than as a bare link.
    const isDocument = !["image", "video", "virtual_tour"].includes(reply.mediaKind);
    if (isDocument) await sendMessengerDocument(to, reply.mediaUrl);
    else await sendMessengerMedia(to, reply.mediaUrl, reply.mediaKind);
    if (reply.caption) await sendMessengerText(to, reply.caption);
    return;
  }

  if (reply.text) await sendMessengerText(to, reply.text);
}
