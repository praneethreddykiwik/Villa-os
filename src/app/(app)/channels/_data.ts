import { CHANNEL_ORDER, adapterFor, channelMeta } from "@/lib/platforms/registry";
import {
  inRange, rollupByChannel, statsFor, timeseries,
  type ChannelRollup, type Range,
} from "@/lib/metrics/aggregate";
import type { ChannelId, Connection, Database, Post, PostFormat } from "@/lib/types";

/**
 * One channel, seen on its own — shared by the comparison index and the tabs.
 *
 * Both surfaces answer the same question about the same channel, and letting
 * each compute it separately is how a comparison table ends up disagreeing with
 * the screen it links into. Everything here comes out of `metrics/aggregate`
 * over the brand's own rows: nothing is synthesised, and a channel that has
 * never synced a day comes back with `rollup: null` rather than a rollup full of
 * zeros a page would be free to print as though it were a measurement.
 */

/**
 * The channels that get a tab.
 *
 * `meta_ads` and `google_ads` are ChannelIds too, but they have no organic
 * surface: their spend, ROAS and creative fatigue live on /ads. TikTok, X,
 * Google Business and WhatsApp have adapters but no tab yet, so they are not
 * listed either — adding one is this array plus a nav entry.
 */
export const CHANNEL_TABS = ["instagram", "facebook", "linkedin", "youtube"] as const satisfies readonly ChannelId[];

/**
 * Runtime narrowing for a path segment. `CHANNEL_ORDER` is the ChannelId union
 * written out as values, so a segment absent from it is not a channel at all
 * and the route has nothing to render.
 */
export function toChannelId(raw: string): ChannelId | null {
  return (CHANNEL_ORDER as readonly string[]).includes(raw) ? (raw as ChannelId) : null;
}

export function isChannelTab(channel: ChannelId): boolean {
  return (CHANNEL_TABS as readonly ChannelId[]).includes(channel);
}

/** Which formats a post actually went out in on this one channel. */
export function formatsOn(post: Post, channel: ChannelId): PostFormat[] {
  return [...new Set(post.targets.filter((t) => t.channel === channel).map((t) => t.format))];
}

export interface FormatRow {
  format: PostFormat;
  posts: number;
  reach: number;
  impressions: number;
  engagements: number;
  engagementRate: number;
  retention3s: number;
}

export type DailyPoint = ReturnType<typeof timeseries>[number];

export interface ChannelSnapshot {
  channel: ChannelId;
  label: string;
  color: string;
  /**
   * Every connection the brand holds on this channel. Usually one, but a brand
   * can legitimately run two Facebook pages or two YouTube channels, so this is
   * a list and the follower figure below is their sum.
   */
  connections: Connection[];
  /**
   * Follower level the connector last reported, or null when nothing is
   * connected. Null and 0 are different answers — "we have no account here" is
   * not "we have an account with no followers" — so the tiles can decline to
   * print a number instead of showing a zero that looks measured.
   */
  followers: number | null;
  lastSyncedAt: string | null;
  /** Null when this channel reported no day inside the range. */
  rollup: ChannelRollup | null;
  previous: ChannelRollup | null;
  series: DailyPoint[];
  /** Published posts that targeted this channel in the range, best reach first. */
  posts: Post[];
  formats: FormatRow[];
  supportedFormats: PostFormat[];
}

export function snapshotFor(
  db: Database,
  brandId: string,
  channel: ChannelId,
  range: Range,
  previous: Range,
): ChannelSnapshot {
  const meta = channelMeta(channel);
  const connections = db.connections.filter((c) => c.brandId === brandId && c.channel === channel);
  const stats = statsFor(db, brandId);

  const rollup = rollupByChannel(stats, range).find((r) => r.channel === channel) ?? null;
  const prevRollup = rollupByChannel(stats, previous).find((r) => r.channel === channel) ?? null;
  const series = timeseries(stats, range, [channel]);

  const posts = db.posts
    .filter(
      (p) =>
        p.brandId === brandId &&
        p.status === "published" &&
        p.metrics !== undefined &&
        p.publishedAt !== undefined &&
        inRange(p.publishedAt.slice(0, 10), range) &&
        p.targets.some((t) => t.channel === channel),
    )
    .sort((a, b) => (b.metrics?.reach ?? 0) - (a.metrics?.reach ?? 0));

  // Only the formats this network actually accepts, straight off the adapter —
  // offering an Instagram "short" or a LinkedIn "story" row would be a breakdown
  // of something that cannot exist.
  const supportedFormats = adapterFor(channel)?.capabilities.formats ?? [];

  const formats = supportedFormats.map<FormatRow>((format) => {
    const inFormat = posts.filter((p) => p.targets.some((t) => t.channel === channel && t.format === format));
    const reach = inFormat.reduce((n, p) => n + (p.metrics?.reach ?? 0), 0);
    const impressions = inFormat.reduce((n, p) => n + (p.metrics?.impressions ?? 0), 0);
    const engagements = inFormat.reduce(
      (n, p) => n + (p.metrics?.likes ?? 0) + (p.metrics?.comments ?? 0) + (p.metrics?.shares ?? 0) + (p.metrics?.saves ?? 0),
      0,
    );
    return {
      format,
      posts: inFormat.length,
      reach,
      impressions,
      engagements,
      engagementRate: impressions ? (engagements / impressions) * 100 : 0,
      retention3s: inFormat.length ? inFormat.reduce((n, p) => n + (p.metrics?.retention3s ?? 0), 0) / inFormat.length : 0,
    };
  });

  return {
    channel,
    label: meta.label,
    color: meta.color,
    connections,
    followers: connections.length ? connections.reduce((n, c) => n + c.followers, 0) : null,
    lastSyncedAt:
      connections
        .map((c) => c.lastSyncedAt)
        .filter((d): d is string => Boolean(d))
        .sort()
        .at(-1) ?? null,
    rollup,
    previous: prevRollup,
    series,
    posts,
    formats,
    supportedFormats,
  };
}

/** True when there is something measured to show. Drives the empty states. */
export function hasSignal(snap: ChannelSnapshot): boolean {
  return snap.rollup !== null || snap.posts.length > 0;
}
