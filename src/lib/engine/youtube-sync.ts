import { mutate } from "../db";
import { fetchYouTubeSnapshotResult, youtubeChannelRef } from "../youtube/public";
import type { Connection, DailyStat } from "../types";

/**
 * YOUTUBE STATS → dailyStats
 *
 * YouTube is the one channel whose numbers are public: the Data API serves a
 * channel's view/subscriber/video counts and each video's views, likes and
 * comments to anyone with an API key, no OAuth grant needed. So an Upload-Post
 * backed YouTube connection — which publishes but carries no token — can still
 * feed /dashboard and /channels/youtube, which read `dailyStats` and nothing
 * else.
 *
 * One row per connection per day. Re-running the sync the same day refreshes
 * that row in place rather than stacking a second one, because
 * `rollupByChannel` sums impressions across rows and a duplicate would double
 * the day's views.
 *
 * The API serves lifetime levels (total views, total videos), but the
 * aggregates sum rows across a date range, so each row must hold that day's
 * movement, not the level. The first row a connection ever gets carries the
 * full lifetime figure (the dashboards would otherwise show 0 for a channel
 * with years of views); every later row stores lifetime minus the sum of all
 * earlier rows. That keeps the invariant "sum of a connection's rows == its
 * lifetime total" without a second store for the level.
 */

/**
 * Only the fields the row needs, so a test (or another source) can hand in a
 * snapshot without building the full YouTube payload.
 */
export interface YouTubeStatsSnapshot {
  channel: { stats: { subscribers: number } };
  videos: Array<{ views: number; likes: number; comments: number }>;
}

/** Null means "no numbers" — the default fetcher turns API errors into that plus a message. */
export type YouTubeSnapshotFetcher = (handle: string) => Promise<YouTubeStatsSnapshot | null>;

export interface YouTubeStatsOutcome {
  ok: boolean;
  /** What went into the row, for the sync report. */
  stats?: Pick<DailyStat, "impressions" | "engagements" | "posts" | "followers">;
  error?: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function syncYouTubeStats(conn: Connection, fetcher?: YouTubeSnapshotFetcher): Promise<YouTubeStatsOutcome> {
  let snap: YouTubeStatsSnapshot | null;
  // Native rows keep the channel title in `handle`; the UC… id resolves reliably.
  const ref = youtubeChannelRef(conn);
  if (fetcher) {
    snap = await fetcher(ref);
  } else {
    // The public client never throws; it hands back a coded error we can show
    // verbatim ("quota exceeded" beats "unavailable").
    const r = await fetchYouTubeSnapshotResult(ref);
    if (!r.ok) return { ok: false, error: `YouTube stats unavailable for ${conn.handle}: ${r.error}` };
    snap = r.snapshot;
  }
  if (!snap) return { ok: false, error: `YouTube stats unavailable for ${conn.handle} — set YOUTUBE_API_KEY or check the handle.` };

  const date = today();
  // Lifetime levels — what the sync report shows and what the deltas below are measured against.
  const lifetimeViews = snap.videos.reduce((n, v) => n + v.views, 0);
  const lifetimeEngagements = snap.videos.reduce((n, v) => n + v.likes + v.comments, 0);
  const stats = { impressions: lifetimeViews, engagements: lifetimeEngagements, posts: snap.videos.length, followers: snap.channel.stats.subscribers };

  mutate((d) => {
    const existing = d.dailyStats.find((s) => s.connectionId === conn.id && s.date === date);
    // Today's row is excluded so a same-day re-run diffs against the same base
    // as the first run did, instead of against itself.
    const earlier = d.dailyStats.filter((s) => s.connectionId === conn.id && s.date < date);
    // Subscriber movement is measured against the newest earlier day we hold,
    // so a first sync reports 0 delta rather than "gained every subscriber today".
    const prior = [...earlier].sort((a, b) => b.date.localeCompare(a.date))[0];
    const followerDelta = prior ? stats.followers - prior.followers : 0;
    // Earlier rows sum to the lifetime level as of the last sync (see header),
    // so today's movement is whatever the API level has grown past that. A
    // deleted video can push the level below the stored sum; clamp at 0 rather
    // than book negative views — the sum then sits above the level until real
    // growth catches up, which is the least surprising of the options.
    const priorSum = (k: "impressions" | "engagements" | "posts") => earlier.reduce((n, s) => n + s[k], 0);
    const impressions = Math.max(0, lifetimeViews - priorSum("impressions"));
    const engagements = Math.max(0, lifetimeEngagements - priorSum("engagements"));
    const posts = Math.max(0, stats.posts - priorSum("posts"));
    const row: DailyStat = {
      brandId: conn.brandId,
      connectionId: conn.id,
      channel: "youtube",
      date,
      followers: stats.followers,
      followerDelta,
      impressions,
      // Public data has no reach/profile/story/link figures; videoViews is the
      // same public view count, which is what the tile means on YouTube.
      reach: 0,
      engagements,
      profileVisits: 0,
      linkClicks: 0,
      posts,
      storyViews: 0,
      videoViews: impressions,
    };
    if (existing) Object.assign(existing, row);
    else d.dailyStats.push(row);

    // The connection card and /channels/youtube read the level off the row.
    const c = d.connections.find((x) => x.id === conn.id);
    if (c) {
      c.followers = stats.followers;
      c.lastSyncedAt = new Date().toISOString();
    }
  });

  return { ok: true, stats };
}
