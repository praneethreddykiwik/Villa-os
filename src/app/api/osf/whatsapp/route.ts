import { NextResponse, after } from "next/server";
import { verifyChallenge, verifySignature } from "@/lib/osf/whatsapp/verify";
import { markRead, sendText } from "@/lib/osf/whatsapp/client";
import { deliverToWhatsApp } from "@/lib/osf/whatsapp/deliver";
import { recordStatuses } from "@/lib/osf/whatsapp/receipts";
import { downloadMedia, transcribeVoiceNote } from "@/lib/osf/whatsapp/media";
import { handleInbound, type InboundAttribution } from "@/lib/osf/conversation";
import {
  describeMedia, type InboundMedia, type InboundMediaKind,
} from "@/lib/osf/whatsapp/inbound-media";
import type { WhatsAppInboundMessage } from "@/lib/osf/whatsapp/types";
import { textFrom, type WhatsAppWebhookBody } from "@/lib/osf/whatsapp/types";
import { maskPhone } from "@/lib/osf/redact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A voice note is download + Whisper + an agent turn; give the function room.
export const maxDuration = 60;

/**
 * Meta's verification handshake. Configure the webhook in the Meta dashboard
 * with this URL and the WHATSAPP_VERIFY_TOKEN from your .env.local.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const challenge = verifyChallenge(params);

  if (!challenge) {
    return new NextResponse("Verification failed", { status: 403 });
  }
  return new NextResponse(challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

/**
 * The media id, kind and filename on a Meta inbound message, if it carries any.
 * Sticker is included: WhatsApp counts it as media and a customer who replies
 * with one has still replied.
 */
function mediaRefOf(
  m: WhatsAppInboundMessage,
): { id: string; kind: InboundMediaKind; filename: string | null } | null {
  if (m.audio?.id) return { id: m.audio.id, kind: "audio", filename: null };
  if (m.image?.id) return { id: m.image.id, kind: "image", filename: null };
  if (m.video?.id) return { id: m.video.id, kind: "video", filename: null };
  if (m.document?.id)
    return { id: m.document.id, kind: "document", filename: m.document.filename ?? null };
  return null;
}

export async function POST(request: Request) {
  // The signature is computed over the exact bytes Meta sent, so read the body
  // as text and parse it ourselves — request.json() would discard the original.
  const raw = await request.text();

  if (!verifySignature(raw, request.headers.get("x-hub-signature-256"))) {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  let body: WhatsAppWebhookBody;
  try {
    body = JSON.parse(raw) as WhatsAppWebhookBody;
  } catch {
    return new NextResponse("Bad payload", { status: 400 });
  }

  // Acknowledge fast. Meta retries anything slower than ~20s, which would mean
  // answering the same customer twice while the first reply is still thinking.
  //
  // after(), not a floating promise: serverless platforms freeze the function
  // the instant the response goes out, so a naked promise dies mid-agent-turn
  // and the customer never gets a reply. after() tells the platform to keep
  // the instance alive until the work finishes. Locally it behaves the same.
  after(async () => {
    try {
      await processWebhook(body);
    } catch (e) {
      console.error("[whatsapp] processing failed", e);
    }
  });

  return NextResponse.json({ received: true });
}

async function processWebhook(body: WhatsAppWebhookBody) {
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;

      // Delivery receipts. Meta sends these in the same webhook shape as
      // messages, and without them every read rate on the dashboard is zero.
      if (value.statuses?.length) {
        await recordStatuses(value.statuses).catch((e) =>
          console.error("[whatsapp] receipt recording failed", e),
        );
      }

      if (!value.messages?.length) continue;

      const profileName = value.contacts?.[0]?.profile?.name ?? null;

      for (const message of value.messages) {
        void markRead(message.id);

        // A voice note carries no text, so transcribe it before anything else —
        // otherwise textFrom() yields a placeholder and the agent can only ask
        // the customer to type it out. Indian buyers send these constantly.
        // Download whatever the customer actually sent, so the thread keeps the
        // file and not merely a transcript or a caption. A failed download must
        // not lose the message, so it degrades to text-only.
        const ref = mediaRefOf(message);
        let media: InboundMedia | null = null;
        if (ref) {
          try {
            const file = await downloadMedia(ref.id);
            media = {
              kind: ref.kind,
              bytes: file.bytes,
              mimeType: file.mimeType,
              filename: ref.filename,
            };
          } catch (e) {
            console.error(`[whatsapp] media download failed for ${ref.id}`, e);
          }
        }

        let text: string | null;
        if (message.type === "audio" && message.audio?.id) {
          const transcript = await transcribeVoiceNote(message.audio.id);
          text = transcript
            ? transcript.text
            : "[the customer sent a voice note that could not be transcribed — ask them to type it, politely]";
          if (transcript) {
            console.log(
              `[whatsapp] transcribed voice note from ${maskPhone(message.from)} (${transcript.language ?? "unknown"})`,
            );
          }
        } else {
          text = textFrom(message);
        }

        // An image, document or sticker sent with no caption has no text. This
        // used to `continue`, so the message was never recorded at all and the
        // thread disagreed with the customer's own phone about what they sent.
        if (!text && ref) text = describeMedia(ref.kind, ref.filename);
        if (!text) continue;

        // Click-to-WhatsApp ads carry the originating ad on the first message.
        // This is the only chance to capture it, so it goes in at lead creation.
        const attribution: InboundAttribution | undefined = message.referral
          ? {
              source: sourceFromReferral(message.referral.source_type),
              adId: message.referral.source_id,
              campaign: message.referral.headline,
              creative: message.referral.media_type,
              landingPage: message.referral.source_url,
            }
          : undefined;

        try {
          const outcome = await handleInbound({
            phone: message.from,
            text,
            profileName,
            channel: "whatsapp",
            waMessageId: message.id,
            attribution,
            media,
            deliver: (reply) => deliverToWhatsApp(message.from, reply),
          });

          if (outcome.status === "skipped") {
            console.log(`[whatsapp] skipped (${outcome.reason}) for ${maskPhone(message.from)}`);
          }
        } catch (e) {
          console.error(`[whatsapp] failed handling message from +${message.from}`, e);
          // Never leave a customer hanging on an internal fault.
          await sendText(
            message.from,
            "Sorry — I'm having trouble on my side just now. Our sales team will get back to you shortly.",
          ).catch(() => {});
        }
      }
    }
  }
}

function sourceFromReferral(sourceType?: string): string {
  switch (sourceType) {
    case "ad":
      return "Meta Ads";
    case "post":
      return "Facebook";
    default:
      return "whatsapp";
  }
}
