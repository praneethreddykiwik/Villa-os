import { NextResponse } from "next/server";
import { read, resolveBrandId } from "@/lib/db";
import { suggestSlots } from "@/lib/engine/besttime";
import type { ChannelId } from "@/lib/types";
import { guard } from "@/lib/auth/guard";

export async function GET(req: Request) {
  const denied = await guard("customers.read");
  if (denied) return denied;

  const url = new URL(req.url);
  const db = read();
  const brandId = resolveBrandId(db, url.searchParams.get("brand"));
  {
    const { getSession, assertBrandAccess } = require("@/lib/auth/session");
    const session = await getSession();
    if (session) assertBrandAccess(session, brandId);
  }
  const channel = (url.searchParams.get("channel") as ChannelId) || undefined;
  const count = Number(url.searchParams.get("count") ?? 5);
  return NextResponse.json({ ok: true, slots: suggestSlots(db, brandId, { count, channel }) });
}
