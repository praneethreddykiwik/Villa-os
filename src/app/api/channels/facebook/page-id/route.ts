import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { mutate, read, resolveBrandId } from "@/lib/db";
import { resetAnalyticsCache } from "@/lib/uploadpost/analytics";

export const dynamic = "force-dynamic";

/**
 * POST /api/channels/facebook/page-id  { brandId, pageId }
 *
 * Saves the Facebook Page id the publishing connector should report analytics
 * for. Only needed when discovery (connector profile, Graph) finds none.
 */
export async function POST(req: Request) {
  const denied = await guard("marketing.publish");
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as { brandId?: string; pageId?: string };
  const pageId = String(body.pageId ?? "").trim();
  if (!/^\d{5,25}$/.test(pageId)) {
    return NextResponse.json({ ok: false, error: "A Facebook Page id is a number (5–25 digits)." }, { status: 400 });
  }
  const brandId = resolveBrandId(read(), body.brandId);
  mutate((d) => {
    const b = d.brands.find((x) => x.id === brandId);
    if (b) b.facebookPageId = pageId;
  });
  resetAnalyticsCache();
  return NextResponse.json({ ok: true, brandId, pageId });
}
