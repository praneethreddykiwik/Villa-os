import { NextResponse } from "next/server";
import { read, resolveBrandId } from "@/lib/db";
import { guard } from "@/lib/auth/guard";
import { fetchYouTubeRecentComments, fetchYouTubeSnapshotResult, youtubeChannelRef } from "@/lib/youtube/public";

export const dynamic = "force-dynamic";

/**
 * GET /api/channels/youtube/recent-comments?brandId=
 *
 * Newest public comments across the brand's last 10 uploads, merged into one
 * feed. Costs one quota unit per video that has comments (videos with none
 * are skipped); the transport caches each read for 2 minutes, so a 30s poll
 * on the page does not multiply the spend.
 */
export async function GET(req: Request) {
  const denied = await guard("analytics.view");
  if (denied) return denied;

  const url = new URL(req.url);
  const db = read();
  const brandId = resolveBrandId(db, url.searchParams.get("brandId") ?? url.searchParams.get("brand"));
  const conn = db.connections.find((c) => c.brandId === brandId && c.channel === "youtube" && c.status !== "disconnected");
  if (!conn?.handle) {
    return NextResponse.json({ ok: false, code: "not_connected", error: "No YouTube account is connected for this brand." }, { status: 404 });
  }

  // The uploads list is served from the snapshot cache the videos route already warmed.
  const snap = await fetchYouTubeSnapshotResult(youtubeChannelRef(conn));
  if (!snap.ok) return NextResponse.json({ ok: false, code: snap.code, error: snap.error });

  const result = await fetchYouTubeRecentComments(snap.snapshot.videos, 10, 10);
  if (!result.ok) return NextResponse.json({ ok: false, code: result.code, error: result.error });
  return NextResponse.json({ ok: true, comments: result.comments, fetchedAt: new Date().toISOString() });
}
