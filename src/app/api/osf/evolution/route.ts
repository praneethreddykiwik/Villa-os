import crypto from "node:crypto";
import { NextResponse, after } from "next/server";
import { env, optional } from "@/lib/osf/env";
import { handleInbound } from "@/lib/osf/conversation";
import {
  describeMedia, type InboundMedia, type InboundMediaKind,
} from "@/lib/osf/whatsapp/inbound-media";
import { db } from "@/lib/osf/supabase";
import { deliverToEvolution, fetchEvolutionMedia, isOwnSentMessage } from "@/lib/osf/evolution/client";
import { passesTrigger, isVillaRelated } from "@/lib/osf/whatsapp/trigger";
import { transcribeAudio, transcriptionConfigured } from "@/lib/osf/whatsapp/media";
import { maskPhone } from "@/lib/osf/redact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Evolution API webhook.
 *
 * Evolution does not sign its payloads the way Meta does, so authentication
 * is a shared secret instead: the webhook URL is configured in Evolution as
 *   https://<app>/api/osf/evolution?token=<EVOLUTION_WEBHOOK_TOKEN>
 * and anything without the exact token is rejected before the body is read.
 * The comparison is constant-time — same discipline as the Meta signature.
 *
 * Evolution fires many event types (connection updates, receipts, presence).
 * Only messages.upsert carries a customer message; everything else is
 * acknowledged and dropped so Evolution doesn't retry-queue events we ignore.
 */

function tokenValid(request: Request): boolean {
  let expected: string;
  try {
    expected = env.evolutionWebhookToken;
  } catch {
    return false; // Not configured — fail closed.
  }
  const provided =
    new URL(request.url).searchParams.get("token") ?? request.headers.get("x-webhook-token") ?? "";
  const a = crypto.createHash("sha256").update(provided, "utf8").digest();
  const b = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Payload shapes (the subset we read). Evolution v2, event "messages.upsert".
// ---------------------------------------------------------------------------
interface EvolutionMessage {
  key?: { remoteJid?: string; fromMe?: boolean; id?: string };
  pushName?: string;
  messageType?: string;
  /** Unix seconds; string or number depending on the Evolution build. */
  messageTimestamp?: number | string;
  message?: {
    conversation?: string;
    extendedTextMessage?: { text?: string };
    imageMessage?: { caption?: string; mimetype?: string };
    documentMessage?: { caption?: string; mimetype?: string; fileName?: string; title?: string };
    audioMessage?: { mimetype?: string };
    videoMessage?: { caption?: string; mimetype?: string };
    stickerMessage?: { mimetype?: string };
    buttonsResponseMessage?: { selectedDisplayText?: string; selectedButtonId?: string };
    listResponseMessage?: { title?: string };
    // A WhatsApp "edit" arrives as a protocolMessage wrapping the new content
    // and the id of the message being edited. Evolution nests it a level deeper
    // under editedMessage on some builds, so both shapes are checked.
    protocolMessage?: {
      key?: { id?: string };
      type?: string;
      editedMessage?: { conversation?: string; extendedTextMessage?: { text?: string } };
    };
    editedMessage?: {
      message?: {
        protocolMessage?: {
          key?: { id?: string };
          type?: string;
          editedMessage?: { conversation?: string; extendedTextMessage?: { text?: string } };
        };
      };
    };
  };
}

interface EvolutionEvent {
  event?: string;
  data?: EvolutionMessage | EvolutionMessage[];
}

/**
 * What kind of media this message carries, if any, and where to read its
 * metadata from. Driven off the message body rather than `messageType` because
 * Evolution builds differ on the latter's spelling.
 */
function mediaKindOf(m: EvolutionMessage): InboundMediaKind | null {
  const msg = m.message;
  if (!msg) return null;
  if (msg.audioMessage) return "audio";
  if (msg.imageMessage) return "image";
  if (msg.documentMessage) return "document";
  if (msg.videoMessage) return "video";
  if (msg.stickerMessage) return "sticker";
  return null;
}

function mediaFilename(m: EvolutionMessage): string | null {
  const d = m.message?.documentMessage;
  return d?.fileName ?? d?.title ?? null;
}

function mediaMimeType(m: EvolutionMessage, kind: InboundMediaKind): string {
  const msg = m.message;
  const declared =
    msg?.audioMessage?.mimetype ??
    msg?.imageMessage?.mimetype ??
    msg?.documentMessage?.mimetype ??
    msg?.videoMessage?.mimetype ??
    msg?.stickerMessage?.mimetype;
  if (declared) return declared;
  const fallback: Record<InboundMediaKind, string> = {
    audio: "audio/ogg", image: "image/jpeg", document: "application/octet-stream",
    video: "video/mp4", sticker: "image/webp",
  };
  return fallback[kind];
}

function textFrom(m: EvolutionMessage): string | null {
  const msg = m.message;
  if (!msg) return null;
  return (
    msg.conversation ??
    msg.extendedTextMessage?.text ??
    msg.buttonsResponseMessage?.selectedDisplayText ??
    msg.listResponseMessage?.title ??
    msg.imageMessage?.caption ??
    msg.documentMessage?.caption ??
    msg.videoMessage?.caption ??
    null
  );
}

/**
 * If this event is a message EDIT, returns the new text and the id of the
 * original message. WhatsApp lets a customer fix a message after sending; we
 * store the corrected version (keeping the original visible) and answer it.
 */
function editFrom(m: EvolutionMessage): { newText: string; originalId: string | null } | null {
  const direct = m.message?.protocolMessage;
  const nested = m.message?.editedMessage?.message?.protocolMessage;
  const proto = direct ?? nested;
  const isEdit =
    m.messageType === "editedMessage" ||
    proto?.type === "MESSAGE_EDIT" ||
    Boolean(proto?.editedMessage);
  if (!isEdit || !proto) return null;
  const newText =
    proto.editedMessage?.conversation ?? proto.editedMessage?.extendedTextMessage?.text ?? "";
  if (!newText) return null;
  return { newText, originalId: proto.key?.id ?? null };
}

/** "919876543210@s.whatsapp.net" → "919876543210"; groups and status → null. */
function phoneFrom(remoteJid: string | undefined): string | null {
  if (!remoteJid) return null;
  if (remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast") return null;
  const bare = remoteJid.split("@")[0].split(":")[0];
  return /^\d{8,15}$/.test(bare) ? bare : null;
}

async function processMessage(m: EvolutionMessage): Promise<void> {
  const phone = phoneFrom(m.key?.remoteJid);
  if (!phone) return; // group / status / malformed jid

  // The agent's own reply, echoed back through the same webhook. Matched by the
  // id we recorded when we sent it, so this holds in a "message yourself" chat
  // where the reply also carries fromMe=true. This is the loop-breaker.
  if (isOwnSentMessage(m.key?.id)) return;

  // fromMe handling.
  //   - Normal chat: the customer's message is fromMe=false; anything fromMe is
  //     the agent or a human replying from the business phone — never customer
  //     input, so skip it.
  //   - Self-chat testing: when the linked number messages itself, the tester's
  //     own messages are fromMe=true. Only then, and only for that exact number,
  //     do we let fromMe through (the agent's own replies are already excluded
  //     above by id).
  if (m.key?.fromMe) {
    const self = env.evolutionSelfNumber;
    if (!self || phone !== self) return;
  }

  // History guard: on first connect Baileys can sync in old conversations as
  // ordinary upsert events. Anything stamped before the cutoff is ignored —
  // never deleted, never answered, never written to the CRM.
  const ignoreBefore = env.evolutionIgnoreBefore;
  if (ignoreBefore !== null) {
    const ts = Number(m.messageTimestamp);
    if (Number.isFinite(ts) && ts > 0 && ts * 1000 < ignoreBefore) return;
  }

  const trigger = env.evolutionTriggerWord;

  // Message edit: store the corrected text as its own row so BOTH the original
  // and the edit stay visible in the transcript, then answer the new version.
  const edit = editFrom(m);
  if (edit) {
    // The edit must still pass the trigger word — a customer editing a private
    // message into something unrelated shouldn't suddenly wake the agent unless
    // the corrected text itself starts with the trigger.
    if (!passesTrigger(edit.newText, trigger)) return;
    await handleInbound({
      phone,
      instagramId: null,
      text: `✏️ (edited) ${edit.newText}`,
      profileName: m.pushName ?? null,
      channel: "whatsapp",
      // Distinct id so it never collides with the original row, and repeated
      // edit deliveries of the same edit stay idempotent.
      waMessageId: edit.originalId ? `${edit.originalId}:edited:${m.messageTimestamp ?? ""}` : null,
      deliver: (reply) => deliverToEvolution(phone, reply),
    });
    return;
  }

  const kind = mediaKindOf(m);
  // Fetch the bytes ONCE, for any media type. They used to be fetched only for
  // audio and then discarded after transcription; now they are kept, so the
  // thread holds the customer's actual photo, document or recording.
  let media: InboundMedia | null = null;
  if (kind && m.key?.id) {
    const fetched = await fetchEvolutionMedia(m.key.id);
    if (fetched) {
      media = {
        kind,
        bytes: fetched.bytes,
        mimeType: fetched.mimeType || mediaMimeType(m, kind),
        filename: mediaFilename(m),
      };
    }
  }

  const isVoice = kind === "audio" && Boolean(m.key?.id);
  let text: string | null;
  if (isVoice && m.key?.id) {
    // Voice notes do NOT need the "villa" prefix — a caller just speaks. We
    // transcribe any voice note and decide afterwards, from the CONTENT,
    // whether it's about the project (see the relevance gate below). Evolution
    // decrypts it for us, Whisper transcribes it —
    // the same downstream path a Meta voice note takes.
    let transcript: string | null = null;
    if (transcriptionConfigured() && media) {
      try {
        const result = await transcribeAudio(media.bytes, media.mimeType);
        transcript = result.text || null;
      } catch (e) {
        console.error("[evolution] transcription failed", e);
      }
    }
    text =
      transcript ??
      "[the customer sent a voice note that could not be transcribed — ask them to type it, politely]";
  } else {
    text = textFrom(m);
  }

  // A photo, document or sticker sent with no caption has no text at all. That
  // used to return here, so the message was never recorded and the thread
  // disagreed with the customer's own phone about what they had sent. Media
  // now supplies its own body line instead.
  if (!text && kind) text = describeMedia(kind, mediaFilename(m));
  if (!text) return;

  // Gating, personal-number mode (a trigger word is set):
  //   • TEXT must start with the trigger word ("villa ...") — this keeps the
  //     agent silent on a personal number's private text chats.
  //   • VOICE notes skip that prefix — a caller just speaks — and instead pass
  //     only if the CONTENT is about the project. A friend's unrelated voice
  //     note transcribes but gets no reply.
  // With no trigger word set (a dedicated business number) everything passes.
  //
  // Failing this gate means the agent stays SILENT — it never meant the message
  // did not happen. It is still recorded below with `reply: false`, because a
  // customer who sends their PAN card with no caption has given us a document
  // whether or not a trigger word was typed in front of it.
  let reply = true;
  if (trigger) {
    const relevant = isVoice ? isVillaRelated(text) : passesTrigger(text, trigger);
    if (!relevant) reply = false;
  }

  const outcome = await handleInbound({
    phone,
    text,
    profileName: m.pushName ?? null,
    channel: "whatsapp",
    waMessageId: m.key?.id ?? null,
    media,
    reply,
    deliver: (reply) => deliverToEvolution(phone, reply),
  });

  if (outcome.status === "skipped") {
    console.log(`[evolution] skipped (${outcome.reason}) for ${maskPhone(phone)}`);
  }
}

/**
 * ONE RESPONDER PER NUMBER.
 *
 * The live WhatsApp agent runs on the VPS and owns Evolution's webhook. If
 * this deployment also accepted `messages.upsert` it would run the agent a
 * second time on the same message, and the customer would get two different
 * replies from one number. That is not a degraded experience — it is the
 * failure the whole console is meant to prevent.
 *
 * So inbound is refused unless somebody deliberately turns it on. It is an
 * explicit opt-in rather than a consequence of EVOLUTION_WEBHOOK_TOKEN being
 * unset, because "safe because a variable happens to be empty" stops being
 * true the moment someone fills that variable in to make sending work.
 *
 * Set EVOLUTION_INBOUND=enabled ONLY on the deployment that owns the number.
 */
function inboundEnabled(): boolean {
  return optional("EVOLUTION_INBOUND").toLowerCase() === "enabled";
}

export async function POST(request: Request) {
  if (!inboundEnabled()) {
    // 410 rather than 404: the endpoint exists and is deliberately closed, so
    // whoever pointed Evolution here gets an answer instead of a mystery.
    return NextResponse.json(
      {
        error:
          "Inbound WhatsApp is disabled on this deployment. The agent that owns this number handles it; " +
          "this console is read plus human reply only. Set EVOLUTION_INBOUND=enabled only on the owning deployment.",
      },
      { status: 410 },
    );
  }

  if (!tokenValid(request)) {
    return NextResponse.json({ error: "invalid token" }, { status: 401 });
  }

  let body: EvolutionEvent;
  try {
    body = (await request.json()) as EvolutionEvent;
  } catch {
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }

  if (body.event !== "messages.upsert" || !body.data) {
    return NextResponse.json({ ignored: true });
  }

  const messages = Array.isArray(body.data) ? body.data : [body.data];

  // Process INLINE, then ack.
  //
  // A floating background promise does NOT work here: Next tears down the
  // request scope once the response is sent, which kills the agent's own
  // fetch() calls ("fetch failed"). Awaiting keeps the scope alive. The agent
  // finishes a turn in a few seconds (single message), well inside any webhook
  // timeout, and the wa_message_id dedup makes any Evolution retry harmless. A
  // burst of a customer's own repeated messages no longer piles up because the
  // conversation lock now waits only briefly before skipping (see conversation.ts).
  for (const m of messages) {
    try {
      await processMessage(m);
    } catch (e) {
      console.error("[evolution] processing failed", e);
    }
  }

  return NextResponse.json({ received: true });
}
