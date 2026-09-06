import { inRange, type Range } from "./aggregate";
import type { DailyStat } from "../types";

/**
 * YOUTUBE AGGREGATION
 *
 * Pure helpers over the two sources the YouTube block reads: `dailyStats`
 * rows (per-day deltas written by engine/youtube-sync) for anything plotted
 * over time, and the live public snapshot for lifetime totals and the video
 * table. Nothing here touches the store or the network so it can be tested
 * with plain fixtures.
 */

/** Only the video fields the block reads; the full YouTubeVideo satisfies it. */
export interface VideoLike {
  id: string;
  title: string;
  publishedAt: string;
  views: number;
  likes: number;
  comments: number;
  url: string;
}

export interface YouTubeDailyPoint {
  date: string;
  views: number;
  engagements: number;
  followers: number;
}

const yt = (stats: DailyStat[]) => stats.filter((s) => s.channel === "youtube");

/** One point per day (views = that day's movement), oldest first. */
export function youtubeSeries(stats: DailyStat[], range: Range): YouTubeDailyPoint[] {
  const byDate = new Map<string, YouTubeDailyPoint>();
  for (const s of yt(stats)) {
    if (!inRange(s.date, range)) continue;
    const row = byDate.get(s.date) ?? { date: s.date, views: 0, engagements: 0, followers: 0 };
    row.views += s.videoViews;
    row.engagements += s.engagements;
    row.followers += s.followers;
    byDate.set(s.date, row);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export interface YouTubeRangeRollup {
  /** Newest subscriber level inside the range (0 when no row). */
  subscribers: number;
  /** Net subscriber movement across the range — sum of the per-day deltas. */
  subscriberDelta: number;
  views: number;
  engagements: number;
  uploads: number;
  days: number;
}

export function youtubeRangeRollup(stats: DailyStat[], range: Range): YouTubeRangeRollup {
  const rows = yt(stats).filter((s) => inRange(s.date, range)).sort((a, b) => a.date.localeCompare(b.date));
  const out: YouTubeRangeRollup = { subscribers: 0, subscriberDelta: 0, views: 0, engagements: 0, uploads: 0, days: 0 };
  const dates = new Set<string>();
  for (const s of rows) {
    out.subscriberDelta += s.followerDelta;
    out.views += s.videoViews;
    out.engagements += s.engagements;
    out.uploads += s.posts;
    dates.add(s.date);
  }
  // Followers is a level: the newest row wins, summed across connections on that day.
  const last = rows[rows.length - 1]?.date;
  out.subscribers = last ? rows.filter((s) => s.date === last).reduce((n, s) => n + s.followers, 0) : 0;
  out.days = dates.size;
  return out;
}

/** Highest-viewed first; ties broken by likes so the order is stable. */
export function topVideos<T extends VideoLike>(videos: T[], n = 5): T[] {
  return [...videos].sort((a, b) => b.views - a.views || b.likes - a.likes).slice(0, n);
}

/** Uploads whose publish date (UTC day) falls inside the range. */
export function uploadsInRange(videos: VideoLike[], range: Range): VideoLike[] {
  return videos.filter((v) => v.publishedAt && inRange(v.publishedAt.slice(0, 10), range));
}

export interface EngagementComposition {
  likes: number;
  comments: number;
  total: number;
  likeShare: number;
  commentShare: number;
}

export function engagementComposition(videos: Array<Pick<VideoLike, "likes" | "comments">>): EngagementComposition {
  const likes = videos.reduce((n, v) => n + v.likes, 0);
  const comments = videos.reduce((n, v) => n + v.comments, 0);
  const total = likes + comments;
  return {
    likes,
    comments,
    total,
    likeShare: total ? (likes / total) * 100 : 0,
    commentShare: total ? (comments / total) * 100 : 0,
  };
}

/** Sum of a snapshot's per-video counts — the lifetime totals the tiles show. */
export function snapshotTotals(videos: VideoLike[]): { views: number; likes: number; comments: number } {
  return videos.reduce(
    (a, v) => ({ views: a.views + v.views, likes: a.likes + v.likes, comments: a.comments + v.comments }),
    { views: 0, likes: 0, comments: 0 },
  );
}

/* ------------------------------------------------------------------ */
/* Freshness                                                            */
/* ------------------------------------------------------------------ */

export const STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * Should the page trigger a YouTube re-sync before rendering?
 *
 * `lastSyncedAt` is the connection stamp; `newestStatDate` the newest YouTube
 * dailyStats day. Either being fresh is enough — a stats row written today by
 * a sync that then failed to stamp the connection is still today's data.
 * No data at all is stale by definition.
 */
export function isStale(
  input: { lastSyncedAt?: string | null; newestStatDate?: string | null },
  now = new Date(),
  ttlMs = STALE_AFTER_MS,
): boolean {
  const t = input.lastSyncedAt ? Date.parse(input.lastSyncedAt) : NaN;
  if (Number.isFinite(t) && now.getTime() - t < ttlMs) return false;
  // A day-granular row cannot prove it is under ten minutes old; only trust
  // it when the connection stamp is missing entirely and the row is today's.
  if (!input.lastSyncedAt && input.newestStatDate === now.toISOString().slice(0, 10)) return false;
  return true;
}

/** "just now" | "4 min ago" | "3 h ago" | "2 d ago" | "never". */
export function updatedAgo(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "never";
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}
