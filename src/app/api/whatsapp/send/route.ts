import { NextResponse } from "next/server";
import { mutate, read } from "@/lib/db";
import { sendWhatsApp } from "@/lib/platforms/whatsapp";
import { guard } from "@/lib/auth/guard";

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
  const to = conv.author.match(/\+?[\d\s]{7,}/)?.[0]?.replace(/\s/g, "") ?? conv.author;

  const result = await sendWhatsApp({
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? conn?.externalId ?? "",
    token: conn?.accessToken ?? process.env.META_SYSTEM_USER_TOKEN ?? "",
    to,
    text: body.text,
    template: body.template,
    lastInboundAt: conv.createdAt,
  });

  if (!result.ok) return NextResponse.json(result, { status: 422 });

  mutate((d) => {
    const c = d.conversations.find((x) => x.id === body.conversationId);
    if (c) {
      c.status = "replied";
      c.reply = body.text ?? `[template: ${body.template?.name}]`;
    }
  });
  return NextResponse.json(result);
}
