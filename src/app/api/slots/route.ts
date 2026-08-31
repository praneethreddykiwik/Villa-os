import { NextResponse } from "next/server";
import { read, resolveBrandId } from "@/lib/db";
import { suggestSlots } from "@/lib/engine/besttime";
import type { ChannelId } from "@/lib/types";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const db = read();
  const brandId = resolveBrandId(db, url.searchParams.get("brand"));
  const channel = (url.searchParams.get("channel") as ChannelId) || undefined;
  const count = Number(url.searchParams.get("count") ?? 5);
  return NextResponse.json({ ok: true, slots: suggestSlots(db, brandId, { count, channel }) });
}
