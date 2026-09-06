import { NextResponse } from "next/server";
import { read, resolveBrandId } from "@/lib/db";
import { guard } from "@/lib/auth/guard";
import { getSession } from "@/lib/auth/session";
import {
  FreshBypassThrottle, discoverFacebookPageId, fetchHistory, fetchPostAnalytics, fetchSocialAnalytics,
  recentPosts, type RecentPost, type SocialChannel, type SocialChannelAnalytics,
} from "@/lib/uploadpost/analytics";
import { isSocialChannel, syncSocialStats } from "@/lib/engine/uploadpost-sync";
import { isUploadPostConnection } from "@/lib/uploadpost/connections";

export const dynamic = "force-dynamic";

/** Manual Refresh may bypass the 5-minute cache once per 20s per user+brand+channel. */
const freshThrottle = new FreshBypassThrottle(20_000);
/** dailyStats is rewritten in place per day; once a minute per connection is plenty for the 60s poll. */
const lastStatsSync = new Map<string, number>();
const STATS_SYNC_MIN_MS = 60_000;

export interface SocialOverviewResponse {
  ok: boolean;
  channel: SocialChannel;
  handle: string | null;
  connected: boolean;
  fresh: boolean;
  retryAfter: number;
  analytics: SocialChannelAnalytics;
  posts: RecentPost[];
  facebookPageId?: string | null;
  lastSyncedAt: string | null;
  fetchedAt: string;
  error?: string;
}

/**
 * GET /api/channels/{instagram|facebook|linkedin}/overview?brandId=&fresh=1
 *
 * Account totals, reach series and recent posts from the publishing
 * connector's analytics for the brand's connector-backed row. Networks the
 * connector cannot report on come back as `ok:true` with `analytics.ok:false`
 * and a reason, so the panel renders the state instead of a red error.
 */
export async function GET(req: Request, { params }: { params: Promise<{ channel: string }> }) {
  const denied = await guard("analytics.view");
  if (denied) return denied;

  const { channel } = await params;
  if (!isSocialChannel(channel)) return NextResponse.json({ ok: false, error: "Unsupported channel" }, { status: 404 });

  const url = new URL(req.url);
  const db = read();
  const brandId = resolveBrandId(db, url.searchParams.get("brandId") ?? url.searchParams.get("brand"));
  {
    const { getSession, assertBrandAccess } = require("@/lib/auth/session");
    const session = await getSession();
    if (session) assertBrandAccess(session, brandId);
  }
  const conn = db.connections.find((c) => c.brandId === brandId && c.channel === channel && c.status !== "disconnected" && isUploadPostConnection(c));

  const wantFresh = url.searchParams.get("fresh") === "1";
  const throttleKey = `${(await getSession())?.userId ?? "anon"}:${brandId}:${channel}`;
  const fresh = wantFresh && freshThrottle.allow(throttleKey);
  const retryAfter = wantFresh && !fresh ? freshThrottle.retryAfter(throttleKey) : 0;

  const saved = db.brands.find((b) => b.id === brandId)?.facebookPageId ?? null;
  const facebookPageId = channel === "facebook" ? await discoverFacebookPageId(saved) : null;
  const [all, history, metrics] = await Promise.all([
    fetchSocialAnalytics({ fresh, facebookPageId }),
    fetchHistory(fresh),
    fetchPostAnalytics(fresh),
  ]);
  const analytics = all[channel];
  const posts = recentPosts(channel, history, metrics);

  // Keep dailyStats current between syncs. Non-blocking; the fetcher hands the
  // sync the slice we already hold so the connector is not called twice.
  if (conn && analytics.ok) {
    const last = lastStatsSync.get(conn.id) ?? 0;
    if (fresh || Date.now() - last >= STATS_SYNC_MIN_MS) {
      lastStatsSync.set(conn.id, Date.now());
      const postsInPeriod = posts.length;
      void syncSocialStats(conn, async () => ({ analytics, postsInPeriod })).catch(() => { /* best-effort */ });
    }
  }

  const body: SocialOverviewResponse = {
    ok: true,
    channel,
    handle: conn?.handle ?? null,
    connected: Boolean(conn),
    fresh,
    retryAfter,
    analytics,
    posts,
    facebookPageId: channel === "facebook" ? facebookPageId : undefined,
    lastSyncedAt: conn?.lastSyncedAt ?? null,
    fetchedAt: new Date().toISOString(),
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
