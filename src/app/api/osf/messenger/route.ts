import { NextResponse, after } from "next/server";
import { verifyChallenge, verifySignature } from "@/lib/osf/whatsapp/verify";
import { MESSENGER_CHANNEL, deliverToMessenger } from "@/lib/osf/messenger/client";
import { handleInbound } from "@/lib/osf/conversation";
import { autoReplyEnabled, autoReplyStatus } from "@/lib/osf/autoreply";
import { env } from "@/lib/osf/env";
import { maskId } from "@/lib/osf/redact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Facebook Messenger webhook.
 *
 * A thin transport, like the Instagram route beside it: unwrap Meta's
 * envelope and hand the text to the same handleInbound() every channel uses,
 * so a Page DM produces the same lead, the same scoring and the same CRM
 * writes as a WhatsApp message from the same person.
 *
 * Whether the agent *answers* is a separate decision, taken by
 * src/lib/osf/autoreply.ts and off unless this deployment is explicitly told
 * otherwise. The message is recorded either way — a silent channel still
 * fills the inbox for a human to reply from.
 */

function messengerConfig(): { verifyToken: string; appSecret: string } | null {
  // The env getters throw on missing configuration, which is right where an
  // operator is driving. Meta drives this one, and a run of 5xxs makes Meta
  // disable the subscription outright — so unconfigured must mean 403/401.
  try {
    return { verifyToken: env.messengerVerifyToken, appSecret: env.messengerAppSecret };
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const config = messengerConfig();
  if (!config) return new NextResponse("Verification failed", { status: 403 });

  const params = new URL(request.url).searchParams;
  const challenge = verifyChallenge(params, config.verifyToken);
  if (challenge) {
    return new NextResponse(challenge, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }
  return new NextResponse("Verification failed", { status: 403 });
}

interface MessagingEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    quick_reply?: { payload?: string };
    attachments?: Array<{ type?: string; payload?: { url?: string } }>;
  };
}

export async function POST(request: Request) {
  const config = messengerConfig();
  if (!config) return new NextResponse("Invalid signature", { status: 401 });

  const raw = await request.text();

  if (!verifySignature(raw, request.headers.get("x-hub-signature-256"), config.appSecret)) {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  let body: { object?: string; entry?: Array<{ messaging?: MessagingEvent[] }> };
  try {
    body = JSON.parse(raw);
  } catch {
    return new NextResponse("Bad payload", { status: 400 });
  }

  // Meta retries anything slower than ~20s, which on a channel that answers
  // would mean replying to the same person twice. after() keeps the instance
  // alive past the response; a bare promise would be frozen mid-turn.
  after(async () => {
    try {
      await process(body);
    } catch (e) {
      console.error("[messenger] processing failed", e);
    }
  });

  return NextResponse.json({ received: true });
}

async function process(body: { entry?: Array<{ messaging?: MessagingEvent[] }> }) {
  const mayReply = autoReplyEnabled("messenger");

  for (const entry of body.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      const senderId = event.sender?.id;
      const message = event.message;
      if (!senderId || !message) continue;

      // Our own outbound messages come back as echoes — including the ones a
      // human just typed in the inbox. Answering one would put the agent in a
      // conversation with itself.
      if (message.is_echo) continue;

      const text =
        message.quick_reply?.payload ??
        message.text ??
        (message.attachments?.length
          ? "[the customer sent an attachment on Messenger — acknowledge it and ask what they'd like to know]"
          : null);

      if (!text) continue;

      try {
        const outcome = await handleInbound({
          messengerId: senderId,
          text,
          channel: MESSENGER_CHANNEL,
          waMessageId: message.mid ?? null,
          reply: mayReply,
          deliver: (reply) => deliverToMessenger(senderId, reply),
        });

        if (outcome.status === "skipped") {
          console.log(
            `[messenger] stored, no reply (${outcome.reason}) for ${maskId(senderId)} — ${autoReplyStatus("messenger")}`,
          );
        }
      } catch (e) {
        console.error(`[messenger] failed handling message from ${maskId(senderId)}`, e);
      }
    }
  }
}
