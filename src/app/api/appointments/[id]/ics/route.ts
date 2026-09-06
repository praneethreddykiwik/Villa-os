import { NextResponse } from "next/server";
import { read } from "@/lib/db";
import { guard } from "@/lib/auth/guard";
import { icsFor } from "@/lib/notify/ics";

/**
 * Calendar file for one site visit. Same bytes the notification email attaches,
 * so what the host drops into their calendar matches what they were emailed.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guard("sales.read");
  if (denied) return denied;

  const { id } = await params;
  const db = read();
  const appointment = (db.appointments ?? []).find((a) => a.id === id);
  if (!appointment) return NextResponse.json({ ok: false, error: "That appointment does not exist." }, { status: 404 });

  const brand = db.brands.find((b) => b.id === appointment.brandId);
  return new Response(icsFor(appointment, { brandName: brand?.name }), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="site-visit-${appointment.id}.ics"`,
      "Cache-Control": "no-store",
    },
  });
}
