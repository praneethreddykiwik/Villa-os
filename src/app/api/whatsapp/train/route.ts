import { NextRequest, NextResponse } from "next/server";
import { mutate, read } from "@/lib/db";
import type { Database } from "@/lib/types";

type WhatsAppConfig = {
  propertyInfo: string;
  localKnowledge: string;
  salesTeam: string;
  bookingFlow: string;
  faqs: string;
  customPrompt: string;
  systemPrompt: string;
  updatedAt: string;
};

type DbWithWhatsApp = Database & { whatsappConfig?: Record<string, WhatsAppConfig> };

/**
 * POST /api/whatsapp/train
 * Saves the WhatsApp AI knowledge base configuration for a brand.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      brandId: string;
      propertyInfo: string;
      localKnowledge: string;
      salesTeam: string;
      bookingFlow: string;
      faqs: string;
      customPrompt?: string;
    };

    if (!body.brandId) {
      return NextResponse.json({ ok: false, error: "brandId is required" }, { status: 400 });
    }

    const existing = read();
    const brand = existing.brands.find((b: { id: string }) => b.id === body.brandId);
    if (!brand) {
      return NextResponse.json({ ok: false, error: "Brand not found" }, { status: 404 });
    }

    const systemPrompt = buildSystemPrompt(body);

    const config: WhatsAppConfig = {
      propertyInfo: body.propertyInfo ?? "",
      localKnowledge: body.localKnowledge ?? "",
      salesTeam: body.salesTeam ?? "",
      bookingFlow: body.bookingFlow ?? "",
      faqs: body.faqs ?? "",
      customPrompt: body.customPrompt ?? "",
      systemPrompt,
      updatedAt: new Date().toISOString(),
    };

    mutate((db: DbWithWhatsApp) => {
      if (!db.whatsappConfig) db.whatsappConfig = {};
      db.whatsappConfig[body.brandId] = config;
    });

    return NextResponse.json({ ok: true, systemPrompt });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/** GET /api/whatsapp/train?brandId=xxx — returns the saved config */
export async function GET(req: NextRequest) {
  const brandId = req.nextUrl.searchParams.get("brandId");
  if (!brandId) return NextResponse.json({ ok: false, error: "brandId required" }, { status: 400 });

  const db = read() as DbWithWhatsApp;
  const config = db.whatsappConfig?.[brandId] ?? null;
  return NextResponse.json({ ok: true, config });
}

function buildSystemPrompt(data: {
  propertyInfo: string;
  localKnowledge: string;
  salesTeam: string;
  bookingFlow: string;
  faqs: string;
  customPrompt?: string;
}): string {
  const parts: string[] = [
    `You are a helpful real estate assistant. You are polite, professional, and knowledgeable.`,
    `Always respond in the language the user writes in (English, Hindi, Telugu, etc.).`,
    `Keep responses concise and friendly. Use bullet points when listing options.`,
    ``,
    `## Properties & Pricing`,
    data.propertyInfo || "(Not configured yet — admin needs to fill this in)",
    ``,
    `## Local Knowledge`,
    data.localKnowledge || "(Not configured yet)",
    ``,
    `## Sales Team`,
    data.salesTeam || "(Not configured yet)",
    ``,
    `## Booking & Scheduling`,
    data.bookingFlow || "(Not configured yet)",
    ``,
    `## Frequently Asked Questions`,
    data.faqs || "(Not configured yet)",
  ];

  if (data.customPrompt?.trim()) {
    parts.push(``, `## Additional Instructions`, data.customPrompt.trim());
  }

  parts.push(
    ``,
    `## Guidelines`,
    `- If asked about prices, refer ONLY to the Properties & Pricing section.`,
    `- If asked about schools, hospitals or amenities, refer to Local Knowledge.`,
    `- If the user wants to speak to a salesman or schedule a call, share the Sales Team contacts.`,
    `- If the user asks how to book or schedule a visit, explain the Booking process.`,
    `- If you don't know something, say you'll connect them with a team member.`,
    `- Never make up facts. Only use information provided in the sections above.`,
  );

  return parts.join("\n");
}
