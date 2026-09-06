import { mutate, read } from "../db";
import { isUploadPostConnection } from "../uploadpost/connections";
import {
  discoverFacebookPageId, fetchHistory, fetchSocialAnalytics,
  type SocialChannel, type SocialChannelAnalytics,
} from "../uploadpost/analytics";
import type { Connection, DailyStat } from "../types";

/**
 * PUBLISHING-CONNECTOR ANALYTICS → dailyStats
 *
 * Instagram, Facebook and LinkedIn rows linked through the publishing
 * connector carry no network token, but the connector exposes an analytics
 * endpoint for the networks it publishes to. This writes one `dailyStats`
 * row per connection per day from it, so /dashboard, /analytics and the
 * channel tabs — which read `dailyStats` and nothing else — fill in.
 *
 * Two kinds of figure come back and they are stored differently:
 *  - `reach_timeseries` (and `impressions_timeseries` when present) are
 *    already per-day. Each point overwrites that day's `reach`/`impressions`
 *    in place — re-running never stacks a second row.
 *  - views, likes, comments, shares, saves are period totals (a rolling
 *    30-day window). The aggregates sum rows across a range, so today's row
 *    holds the total minus what earlier rows inside the window already
 *    booked; the sum of the window's rows then tracks the connector's total.
 */

export interface SocialSyncInput {
  analytics: SocialChannelAnalytics;
  /** Successful uploads to this network inside the period, for the posts delta. */
  postsInPeriod: number;
}

/** Test seam: the sync reads analytics through this when given. */
export type SocialAnalyticsFetcher = (channel: SocialChannel, conn: Connection) => Promise<SocialSyncInput | null>;

export interface SocialSyncOutcome {
  ok: boolean;
  /** "skipped" is a state the connector reported (LinkedIn personal, no page id), not a failure. */
  skipped?: boolean;
  stats?: Pick<DailyStat, "impressions" | "engagements" | "posts" | "followers"> & { reach: number };
  error?: string;
  detail?: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function windowStart(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}

/**
 * Pure planner: given the connection's existing rows, the analytics slice and
 * the date, return the full set of rows to upsert (keyed by date). Exported
 * so the delta arithmetic is pinned by tests without touching the store.
 */
export function planSocialRows(
  conn: Pick<Connection, "id" | "brandId" | "channel">,
  existing: DailyStat[],
  input: SocialSyncInput,
  date = today(),
): DailyStat[] {
  const { analytics, postsInPeriod } = input;
  const t = analytics.totals;
  const byDate = new Map<string, DailyStat>();
  const blank = (d: string): DailyStat => ({
    brandId: conn.brandId, connectionId: conn.id, channel: conn.channel, date: d,
    followers: t.followers, followerDelta: 0, impressions: 0, reach: 0, engagements: 0,
    profileVisits: 0, linkClicks: 0, posts: 0, storyViews: 0, videoViews: 0,
  });
  const rowFor = (d: string): DailyStat => {
    let r = byDate.get(d);
    if (!r) {
      const prev = existing.find((s) => s.date === d);
      r = prev ? { ...prev } : blank(d);
      byDate.set(d, r);
    }
    return r;
  };

  // Per-day series: overwrite in place, never past today.
  for (const p of analytics.reachSeries) if (p.date <= date) rowFor(p.date).reach = p.value;
  for (const p of analytics.impressionsSeries) if (p.date <= date) rowFor(p.date).impressions = p.value;

  // Period totals → today's delta against what the window's earlier rows already hold.
  const from = windowStart(date, analytics.periodDays);
  const earlier = existing.filter((s) => s.date >= from && s.date < date);
  const sum = (k: keyof DailyStat) => earlier.reduce((n, s) => n + (typeof s[k] === "number" ? (s[k] as number) : 0), 0);
  const engagementsTotal = t.likes + t.comments + t.shares + t.saves;
  const todayRow = rowFor(date);
  todayRow.engagements = Math.max(0, engagementsTotal - sum("engagements"));
  todayRow.videoViews = Math.max(0, t.views - sum("videoViews"));
  todayRow.profileVisits = Math.max(0, t.profileViews - sum("profileVisits"));
  todayRow.posts = Math.max(0, postsInPeriod - sum("posts"));
  if (analytics.impressionsSeries.length === 0) todayRow.impressions = Math.max(0, t.impressions - sum("impressions"));
  // No reach series at all: fall back to the same delta rule so the total still lands.
  if (analytics.reachSeries.length === 0) todayRow.reach = Math.max(0, t.reach - sum("reach"));

  // Follower level on every row; movement measured against the newest earlier day.
  const prior = [...existing].filter((s) => s.date < date).sort((a, b) => b.date.localeCompare(a.date))[0];
  for (const r of byDate.values()) r.followers = t.followers;
  todayRow.followerDelta = prior ? t.followers - prior.followers : 0;

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Default fetcher: connector analytics plus the upload history for the posts count. */
export async function defaultSocialFetcher(channel: SocialChannel, conn: Connection): Promise<SocialSyncInput | null> {
  const saved = read().brands.find((b) => b.id === conn.brandId)?.facebookPageId ?? null;
  const pageId = channel === "facebook" ? await discoverFacebookPageId(saved) : null;
  const all = await fetchSocialAnalytics({ facebookPageId: pageId });
  const analytics = all[channel];
  const history = await fetchHistory();
  const from = windowStart(today(), analytics.periodDays);
  const postsInPeriod = history.filter((h) => h.platform === channel && h.success && h.uploadedAt.slice(0, 10) >= from).length;
  return { analytics, postsInPeriod };
}

export function isSocialChannel(ch: string): ch is SocialChannel {
  return ch === "instagram" || ch === "facebook" || ch === "linkedin";
}

export async function syncSocialStats(conn: Connection, fetcher: SocialAnalyticsFetcher = defaultSocialFetcher): Promise<SocialSyncOutcome> {
  if (!isSocialChannel(conn.channel) || !isUploadPostConnection(conn)) {
    return { ok: false, error: `${conn.channel} is not linked through the publishing connector.` };
  }
  const input = await fetcher(conn.channel, conn);
  if (!input) return { ok: false, error: `Analytics unavailable for ${conn.handle}: the publishing connector returned nothing.` };
  const a = input.analytics;
  if (!a.ok) {
    if (a.reason === "personal_unsupported" || a.reason === "page_id_required") {
      return { ok: false, skipped: true, detail: a.message ?? "Analytics are not available for this account." };
    }
    return { ok: false, error: `Analytics unavailable for ${conn.handle}: ${a.message ?? a.reason ?? "unknown error"}` };
  }

  const date = today();
  const stats = mutate((d) => {
    const existing = d.dailyStats.filter((s) => s.connectionId === conn.id);
    const rows = planSocialRows(conn, existing, input, date);
    for (const row of rows) {
      const cur = d.dailyStats.find((s) => s.connectionId === conn.id && s.date === row.date);
      if (cur) Object.assign(cur, row);
      else d.dailyStats.push(row);
    }
    const c = d.connections.find((x) => x.id === conn.id);
    if (c) {
      c.followers = a.totals.followers;
      c.lastSyncedAt = new Date().toISOString();
    }
    const t = rows.find((r) => r.date === date)!;
    return { impressions: a.totals.impressions, engagements: t.engagements, posts: input.postsInPeriod, followers: a.totals.followers, reach: a.totals.reach };
  });
  return { ok: true, stats, detail: `Analytics refreshed for the last ${a.periodDays} days: ${a.totals.reach} reach, ${a.totals.views} views, ${a.totals.followers} followers.` };
}
