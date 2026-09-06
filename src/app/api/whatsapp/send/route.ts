import { NextResponse } from "next/server";
import { mutate, read } from "@/lib/db";
import { sendWhatsApp } from "@/lib/platforms/whatsapp";
import { guard } from "@/lib/auth/guard";
import { getSession } from "@/lib/auth/session";
import { findByPhone } from "@/lib/ops/customers";
import { recordExternalOutbound } from "@/lib/ops/inbox";

/**
 * Reply on WhatsApp. The 24-hour service window is enforced before the call, so
 * a rejected send tells you *why* and offers the template path instead of
 * surfacing an opaque Meta error code.
 */
export async function POST(req: Request) {
  const denied = await guard("customers.write");
  if (denied) return denied;

  const body = (await req.json()) as {
    conversationId: string;
    text?: string;
    template?: { name: string; language: string; params?: string[] };
  };

  const db = read();
  const conv = db.conversations.find((c) => c.id === body.conversationId);
  if (!conv) return NextResponse.json({ ok: false, error: "conversation not found" }, { status: 404 });

  const conn = db.connections.find((c) => c.brandId === conv.brandId && c.channel === "whatsapp");

  // The recipient is read from the stored sender id, never scraped out of
  // `conv.author`. That string is "profile name (wa_id)", and the profile name
  // half is whatever the customer typed into WhatsApp. Setting it to another
  // phone number put the attacker's digits *first*, so the old
  // /\+?[\d\s]{7,}/ scan matched them instead of the real wa_id and every staff
  // reply — loan status, document chases, anything already drafted about that
  // customer — was delivered to a number the customer's counterparty chose.
  // `authorId` is recorded at ingest from the signature-verified webhook body,
  // which the sender cannot influence.
  const to = (conv.authorId ?? "").replace(/[^\d+]/g, "");
  if (!/^\+?\d{7,20}$/.test(to)) {
    // Fail closed rather than falling back to the display string: a
    // conversation with no verified sender id (a pre-existing row, or a channel
    // that never carried one) has no address we are willing to trust.
    return NextResponse.json(
      { ok: false, error: "conversation has no verified sender id to reply to" },
      { status: 409 },
    );
  }

  const result = await sendWhatsApp({
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? conn?.externalId ?? "",
    token: conn?.accessToken ?? process.env.WHATSAPP_ACCESS_TOKEN ?? process.env.META_SYSTEM_USER_TOKEN ?? "",
    to,
    text: body.text,
    template: body.template,
    lastInboundAt: conv.createdAt,
  });

  if (!result.ok) return NextResponse.json(result, { status: 422 });

  // Every outbound must appear in the customer's conversation history. This
  // path used to bypass opsMessages entirely, so staff replies sent from the
  // social inbox were invisible to the WhatsApp inbox and to the agent.
  const session = await getSession();
  if (session) {
    const customer = findByPhone(session.orgId, to);
    if (customer) {
      recordExternalOutbound({
        orgId: session.orgId,
        customerId: customer.id,
        body: body.text ?? `[template: ${body.template?.name}]`,
        authorType: "human",
        authorId: session.userId,
        externalId: result.messageId,
      });
    }
  }

  mutate((d) => {
    const c = d.conversations.find((x) => x.id === body.conversationId);
    if (c) {
      c.status = "replied";
      c.reply = body.text ?? `[template: ${body.template?.name}]`;
    }
  });
  return NextResponse.json(result);
}
