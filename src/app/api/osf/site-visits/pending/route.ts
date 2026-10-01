import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { pendingVisitRequests } from "@/lib/osf/site-visit-booking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How many site-visit requests are waiting. Drives the badge on the bell. */
export async function GET() {
  const denied = await guard("customers.read");
  if (denied) return denied;
  return NextResponse.json({ ok: true, pending: await pendingVisitRequests() });
}
