import { NextResponse } from "next/server";
import { mutate, read } from "@/lib/db";
import { uid } from "@/lib/ids";
import { parseWebhook } from "@/lib/platforms/whatsapp";

/**
 * Meta verifies a webhook by GETting it with a challenge and expects the raw
 * challenge string echoed back — not JSON. Returning JSON here is the classic
 * reason a WhatsApp webhook never activates.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge") ?? "";

  if (mode === "subscribe" && token === (process.env.WHATSAPP_VERIFY_TOKEN ?? "dev-verify")) {
    return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
  }
  return new Response("forbidden", { status: 403 });
}

/**
 * Inbound messages. Meta retries anything that is not answered quickly with a
 * 200, so we acknowledge first and keep the work minimal — and we key on the
 * platform message id so a retry cannot duplicate the conversation.
 */
export async function POST(req: Request) {
  const payload = await req.json();
  const messages = parseWebhook(payload);
  if (!messages.length) return NextResponse.json({ ok: true, ignored: "no messages in payload" });

  const db = read();
  const conn = db.connections.find((c) => c.channel === "whatsapp");
  const brandId = conn?.brandId ?? db.brands[0]?.id;
  if (!brandId) return NextResponse.json({ ok: true, ignored: "no brand" });

  const created = mutate((d) => {
    const seen = new Set(d.conversations.map((c) => c.id));
    let n = 0;
    for (const m of messages) {
      if (seen.has(m.id)) continue;
      n += 1;
      d.conversations.unshift({
        id: m.id,
        brandId,
        channel: "whatsapp",
        kind: "dm",
        author: m.name ? `${m.name} (${m.from})` : m.from,
        text: m.text,
        createdAt: m.timestamp,
        status: "open",
        sentiment: "neutral",
        isLead: /price|cost|how much|available|availability|book|quote/i.test(m.text),
      });
    }
    if (n) {
      d.activity.unshift({
        id: uid("act"),
        brandId,
        at: new Date().toISOString(),
        actor: "system",
        kind: "whatsapp",
        message: `${n} WhatsApp message(s) received`,
      });
    }
    return n;
  });

  return NextResponse.json({ ok: true, received: messages.length, created });
}
