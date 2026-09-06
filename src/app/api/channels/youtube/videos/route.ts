import { NextResponse } from "next/server";
import { read, resolveBrandId } from "@/lib/db";
import { guard } from "@/lib/auth/guard";
import { getSession } from "@/lib/auth/session";
import { fetchYouTubeSnapshotResult, youtubeChannelRef, type YouTubeSnapshot } from "@/lib/youtube/public";
import { FreshBypassThrottle } from "@/lib/youtube/studio";
import { syncYouTubeStats } from "@/lib/engine/youtube-sync";

export const dynamic = "force-dynamic";

/** Manual Refresh may skip the server cache once per 20s per user+brand — each bypass spends ~3 quota units. */
const freshThrottle = new FreshBypassThrottle(20_000);
/**
 * Non-fresh reads share one snapshot per brand for SNAPSHOT_MIN_MS. The lib
 * cache TTL (15s) is shorter than the 30s poll, so without this every polling
 * client — and anything hitting the route faster than the poll — would spend
 * ~3 units per request with no server-side floor.
 */
const lastSnapshot = new Map<string, { at: number; snapshot: YouTubeSnapshot }>();
const SNAPSHOT_MIN_MS = 30_000;
/** dailyStats is rewritten in place per day; once a minute per connection is plenty for a 30s poll. */
const lastStatsSync = new Map<string, number>();
const STATS_SYNC_MIN_MS = 60_000;

/**
 * GET /api/channels/youtube/videos?brandId=&fresh=1
 *
 * Public YouTube snapshot (channel stats + every upload with counts) for the
 * brand's YouTube connection. Reads go through the API key, so this works for
 * Upload-Post-backed rows that hold no OAuth token. Provider failures come
 * back as a 200 with `ok:false` and a code — the panel renders the reason
 * inline rather than turning a quota blip into a red 500.
 *
 * `fresh=1` bypasses the in-process cache (rate-limited above); the response
 * says whether the bypass was honoured so the client can show "throttled".
 */
export async function GET(req: Request) {
  const denied = await guard("marketing.read");
  if (denied) return denied;

  const url = new URL(req.url);
  const db = read();
  const brandId = resolveBrandId(db, url.searchParams.get("brandId") ?? url.searchParams.get("brand"));
  const conn = db.connections.find((c) => c.brandId === brandId && c.channel === "youtube" && c.status !== "disconnected");
  if (!conn?.handle) {
    return NextResponse.json({ ok: false, code: "not_connected", error: "No YouTube account is connected for this brand." }, { status: 404 });
  }

  const wantFresh = url.searchParams.get("fresh") === "1";
  // Keyed per user so one person's Refresh does not lock everyone else's for 20s.
  const throttleKey = `${(await getSession())?.userId ?? "anon"}:${brandId}`;
  const fresh = wantFresh && freshThrottle.allow(throttleKey);
  const retryAfter = wantFresh && !fresh ? freshThrottle.retryAfter(throttleKey) : 0;

  const recent = lastSnapshot.get(brandId);
  if (!fresh && recent && Date.now() - recent.at < SNAPSHOT_MIN_MS) {
    return NextResponse.json({ ok: true, handle: conn.handle, fresh: false, retryAfter, ...recent.snapshot });
  }

  // Native rows keep the channel title in `handle`; the UC… id resolves reliably.
  const result = await fetchYouTubeSnapshotResult(youtubeChannelRef(conn), { fresh });
  if (!result.ok) return NextResponse.json({ ok: false, code: result.code, error: result.error, handle: conn.handle });
  lastSnapshot.set(brandId, { at: Date.now(), snapshot: result.snapshot });

  // Keep dailyStats current between daily syncs. syncYouTubeStats rewrites
  // today's row in place, so repeating it is safe; the fetcher hands it the
  // snapshot we already hold so no quota is spent twice. Non-blocking.
  const last = lastStatsSync.get(conn.id) ?? 0;
  if (fresh || Date.now() - last >= STATS_SYNC_MIN_MS) {
    lastStatsSync.set(conn.id, Date.now());
    const snapshot = result.snapshot;
    void syncYouTubeStats(conn, async () => snapshot).catch(() => { /* stats row is best-effort */ });
  }

  return NextResponse.json({ ok: true, handle: conn.handle, fresh, retryAfter, ...result.snapshot });
}
