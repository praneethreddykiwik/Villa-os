import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { handleInbound } from "@/lib/ops/agent";
import { resolveDefaultOrgId, ensureOpsSeed, syncTeamMembers } from "@/lib/ops/seed";
import { mutate, read } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = await guard("customers.write");
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as {
    phone?: string;
    name?: string;
    body?: string;
    type?: "text" | "document" | "image";
    documentType?: "aadhaar" | "pan" | "bank_statements" | "income_proof" | "property_documents";
    filename?: string;
    fileContent?: string;
  };

  const phone = (body.phone ?? "+919876543210").trim();
  const name = (body.name ?? "Prospective Buyer").trim();
  const text = (body.body ?? "Hi, I am interested in Glentree villas").trim();
  const type = body.type ?? "text";

  const orgId = await resolveDefaultOrgId();
  ensureOpsSeed(orgId);
  await syncTeamMembers(orgId);

  const messageId = `wamid.sim_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const timestamp = new Date().toISOString();

  let media;
  if (type === "document" || type === "image") {
    const filename = body.filename ?? `${body.documentType ?? "document"}.pdf`;
    const mimeType = filename.endsWith(".pdf") ? "application/pdf" : "image/jpeg";
    const data = body.fileContent 
      ? Buffer.from(body.fileContent, "base64")
      : Buffer.from(`%PDF-1.4 Simulated ${body.documentType ?? "document"} for ${name}`);
    
    media = {
      data,
      mimeType,
      filename,
    };
  }

  const db = read();
  const brandId = db.brands[0]?.id ?? "brd_mtm0foop58fc";
  mutate((d) => {
    d.conversations.unshift({
      id: messageId,
      brandId,
      channel: "whatsapp",
      kind: "dm",
      author: `${name} (${phone})`,
      authorId: phone,
      text: type === "text" ? text : `[${type}: ${body.filename ?? "file"}] ${text}`,
      createdAt: timestamp,
      status: "open",
      sentiment: "neutral",
      isLead: true,
    });
  });

  const outcome = await handleInbound({
    orgId,
    phone,
    name,
    body: text,
    externalId: messageId,
    receivedAt: timestamp,
    type,
    media,
  });

  return NextResponse.json({
    ok: true,
    messageId,
    customerId: outcome.customerId,
    reply: outcome.reply,
    replyTag: outcome.replyTag,
    salesTaskId: outcome.salesTaskId,
    documentId: outcome.documentId,
    appointmentId: outcome.appointmentId,
  });
}
