import { NextResponse } from "next/server";
import { read, resolveBrandId } from "@/lib/db";
import { generateCopy, generateHooks } from "@/lib/ai/copy";
import type { ChannelId, PostFormat } from "@/lib/types";
import { guard } from "@/lib/auth/guard";

export async function POST(req: Request) {
  const denied = await guard("marketing.read");
  if (denied) return denied;

  const body = (await req.json()) as {
    brandId?: string;
    topic: string;
    format: PostFormat;
    channels: ChannelId[];
    cta?: string;
    tone?: "warm" | "punchy" | "luxury" | "playful" | "informative";
    hooksFor?: string;
  };
  const db = read();
  const brand = db.brands.find((b) => b.id === resolveBrandId(db, body.brandId))!;

  if (body.hooksFor) {
    const hooks = await generateHooks(brand, body.topic, body.hooksFor);
    return NextResponse.json({ ok: true, hooks });
  }

  const variants = await generateCopy({
    brand,
    topic: body.topic,
    format: body.format,
    channels: body.channels,
    cta: body.cta,
    tone: body.tone,
  });
  return NextResponse.json({ ok: true, variants });
}
