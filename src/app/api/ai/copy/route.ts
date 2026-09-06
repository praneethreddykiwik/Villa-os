import { NextResponse } from "next/server";
import { read, resolveBrandId } from "@/lib/db";
import { generateCopy, generateHooks } from "@/lib/ai/copy";
import type { ChannelId, PostFormat } from "@/lib/types";
import { guard } from "@/lib/auth/guard";
import { apiError, apiFail } from "@/lib/auth/http";

export async function POST(req: Request) {
  const denied = await guard("marketing.read");
  if (denied) return denied;

  try {
    let body: {
      brandId?: string;
      topic?: string;
      format?: PostFormat;
      channels?: ChannelId[];
      cta?: string;
      tone?: "warm" | "punchy" | "luxury" | "playful" | "informative";
      hooksFor?: string;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return apiFail("Request body must be valid JSON.", 400);
    }

    const topic = body.topic?.trim();
    if (!topic) return apiFail("topic is required.", 400);

    const db = read();
    const brandId = resolveBrandId(db, body.brandId);
  {
    const { getSession, assertBrandAccess } = require("@/lib/auth/session");
    const session = await getSession();
    if (session) assertBrandAccess(session, brandId);
  }
    const brand = db.brands.find((b) => b.id === brandId);
    if (!brand) return apiFail("Brand not found.", 404);

    if (body.hooksFor) {
      const hooks = await generateHooks(brand, topic, body.hooksFor);
      return NextResponse.json({ ok: true, hooks });
    }

    const format = body.format ?? "feed";
    const channels: ChannelId[] = body.channels && body.channels.length ? body.channels : (["instagram"] as ChannelId[]);

    const variants = await generateCopy({
      brand,
      topic,
      format,
      channels,
      cta: body.cta,
      tone: body.tone,
    });
    return NextResponse.json({ ok: true, variants });
  } catch (e) {
    return apiError(e);
  }
}

