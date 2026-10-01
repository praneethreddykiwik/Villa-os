import { NextResponse } from "next/server";
import { db } from "@/lib/osf/supabase";
import { guard } from "@/lib/auth/guard";
import { errorRef } from "@/lib/auth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Toggles a content draft between 'draft' and 'ready'. Never publishes anything. */
export async function POST(request: Request) {
  const denied = await guard("marketing.publish");
  if (denied) return denied;
  const { id, status } = (await request.json()) as { id?: string; status?: string };

  if (!id || (status !== "draft" && status !== "ready" && status !== "archived")) {
    return NextResponse.json({ error: "id and a valid status are required" }, { status: 400 });
  }

  const { error } = await db().from("villa_content_drafts").update({ status }).eq("id", id);
  if (error) return NextResponse.json({ error: "That did not work. Quote this reference if you report it.", ref: errorRef(error, "osf:marketing") }, { status: 500 });

  return NextResponse.json({ ok: true });
}
