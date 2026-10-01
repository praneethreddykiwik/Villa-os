import { env } from "../env";
import { toWhatsApp } from "../whatsapp/format";
import type { AgentReply, AssetKind } from "../types";

/**
 * Evolution API sender — the unofficial transport.
 *
 * Evolution drives a normal WhatsApp account over the Web protocol, so there
 * are no templates, no 24-hour window and no per-message fees. The flip side
 * is that interactive buttons are unreliable on this protocol (Meta half-
 * removed them from WhatsApp Web), so anything with options degrades to a
 * numbered text menu here rather than risking a message that renders blank on
 * the customer's phone.
 *
 * Every function throws on failure, same contract as the Meta client: the
 * agent must never believe a message was delivered when it was not.
 */

/**
 * IDs of messages this process has sent through Evolution.
 *
 * WhatsApp echoes our own outbound messages back through the same
 * messages.upsert webhook. In a normal customer chat those carry fromMe=true
 * and are easy to skip — but in a "message yourself" chat (testing on the
 * linked number) the customer's own messages ALSO carry fromMe=true, so
 * fromMe alone cannot tell an agent reply from a real question. Matching on the
 * id we got back when we sent can: it is unambiguous in every chat type.
 *
 * Bounded so a long-running process cannot grow this without limit.
 */
const sentMessageIds = new Set<string>();
const SENT_ID_CAP = 1000;

export function rememberSentMessage(id: string | null | undefined): void {
  if (!id) return;
  if (sentMessageIds.size >= SENT_ID_CAP) {
    // Drop the oldest ~10% in insertion order.
    const drop = Math.floor(SENT_ID_CAP * 0.1);
    let i = 0;
    for (const k of sentMessageIds) {
      sentMessageIds.delete(k);
      if (++i >= drop) break;
    }
  }
  sentMessageIds.add(id);
}

export function isOwnSentMessage(id: string | null | undefined): boolean {
  return id ? sentMessageIds.has(id) : false;
}

function base(): string {
  const url = env.evolutionApiUrl;
  if (!/^https?:\/\//.test(url)) {
    throw new Error("EVOLUTION_API_URL must start with http:// or https://");
  }
  return url;
}

/**
 * Evolution downloads the media itself before it can answer, so a send is only
 * as fast as its fetch of our file. A 17 MB brochure over a slow link held this
 * open indefinitely, and on a serverless function an un-timed fetch means the
 * whole request is killed by the platform instead — losing the activity row
 * that records what was already delivered.
 */
const SEND_TIMEOUT_MS = 45_000;

async function post<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${base()}${path}`, {
    method: "POST",
    headers: { apikey: env.evolutionApiKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Evolution send failed (${response.status}): ${detail.slice(0, 400)}`);
  }
  return (await response.json().catch(() => ({}))) as T;
}

/** Digits only, international format — same rule as the Meta client. */
function recipient(to: string): string {
  const digits = to.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) {
    throw new Error("WhatsApp recipient must be an international number in digits");
  }
  return digits;
}

interface SendResponse {
  key?: { id?: string };
}

export async function sendEvolutionText(to: string, body: string) {
  const result = await post<SendResponse>(`/message/sendText/${env.evolutionInstance}`, {
    number: recipient(to),
    text: toWhatsApp(body).slice(0, 4096),
    linkPreview: false,
  });
  rememberSentMessage(result.key?.id);
  return { messageId: result.key?.id ?? null };
}

function mediaTypeFor(kind: AssetKind): "image" | "video" | "document" {
  if (kind === "image") return "image";
  if (kind === "video" || kind === "virtual_tour") return "video";
  return "document";
}

export async function sendEvolutionMedia(
  to: string,
  url: string,
  kind: AssetKind,
  caption?: string,
) {
  const link = new URL(url);
  if (link.protocol !== "https:" && link.protocol !== "http:") {
    throw new Error("Evolution media link must be http or https");
  }
  const mediatype = mediaTypeFor(kind);
  const result = await post<SendResponse>(`/message/sendMedia/${env.evolutionInstance}`, {
    number: recipient(to),
    mediatype,
    media: link.href,
    ...(caption ? { caption: caption.slice(0, 1024) } : {}),
    ...(mediatype === "document" ? { fileName: `${kind.replace(/_/g, "-")}.pdf` } : {}),
  });
  rememberSentMessage(result.key?.id);
  return { messageId: result.key?.id ?? null };
}

/**
 * Downloads and decrypts a received media message (voice note, image).
 *
 * WhatsApp media arrives end-to-end encrypted; the Evolution server holds the
 * session keys, so it does the decryption and hands back plain base64.
 */
export async function fetchEvolutionMedia(
  messageId: string,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  try {
    const result = await post<{ base64?: string; mimetype?: string }>(
      `/chat/getBase64FromMediaMessage/${env.evolutionInstance}`,
      { message: { key: { id: messageId } }, convertToMp4: false },
    );
    if (!result.base64) return null;
    return {
      bytes: Buffer.from(result.base64, "base64"),
      mimeType: result.mimetype ?? "audio/ogg",
    };
  } catch (e) {
    console.error("[evolution] media fetch failed", e);
    return null;
  }
}

/** "open" means the QR was scanned and the WhatsApp session is live. */
export async function evolutionConnectionState(): Promise<string> {
  const response = await fetch(
    `${base()}/instance/connectionState/${env.evolutionInstance}`,
    { headers: { apikey: env.evolutionApiKey } },
  );
  if (!response.ok) throw new Error(`Evolution unreachable (${response.status})`);
  const json = (await response.json()) as { instance?: { state?: string } };
  return json.instance?.state ?? "unknown";
}

/**
 * The Evolution counterpart of deliverToWhatsApp — one AgentReply in, the
 * right Evolution call out. Options become a numbered menu (see module note).
 */
export async function deliverToEvolution(to: string, reply: AgentReply): Promise<void> {
  if (reply.options?.length) {
    const body = reply.text ?? "Please choose:";
    const numbered = reply.options.map((o, i) => `${i + 1}. ${o.title}`).join("\n");
    await sendEvolutionText(to, `${body}\n\n${numbered}\n\nReply with a number.`);
    return;
  }
  if (reply.mediaUrl && reply.mediaKind) {
    await sendEvolutionMedia(to, reply.mediaUrl, reply.mediaKind, reply.caption);
    return;
  }
  if (reply.text) await sendEvolutionText(to, reply.text);
}
