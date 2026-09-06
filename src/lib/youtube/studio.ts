/**
 * YOUTUBE STUDIO PANEL — PURE HELPERS
 *
 * Everything the channel page derives from a public snapshot lives here so
 * the node:test suite (which compiles src/lib only) can pin the numbers
 * without rendering React. No I/O in this file.
 */

import type { YouTubeCommentThread, YouTubeVideo } from "./public";

export interface YouTubeTotals {
  views: number;
  likes: number;
  comments: number;
  uploads: number;
  avgViews: number;
  /** (likes + comments) / views, as a 0..1 ratio; 0 when there are no views. */
  engagementRate: number;
}

export function computeTotals(videos: Pick<YouTubeVideo, "views" | "likes" | "comments">[]): YouTubeTotals {
  const views = videos.reduce((n, v) => n + v.views, 0);
  const likes = videos.reduce((n, v) => n + v.likes, 0);
  const comments = videos.reduce((n, v) => n + v.comments, 0);
  const uploads = videos.length;
  return {
    views, likes, comments, uploads,
    avgViews: uploads ? views / uploads : 0,
    engagementRate: views ? (likes + comments) / views : 0,
  };
}

/** 1-based rank of `id` when videos are ordered by views (ties keep upload order). */
export function rankByViews(videos: Pick<YouTubeVideo, "id" | "views">[], id: string): number {
  const sorted = [...videos].sort((a, b) => b.views - a.views);
  const i = sorted.findIndex((v) => v.id === id);
  return i < 0 ? 0 : i + 1;
}

/**
 * Bar width (0..100) for "this video vs the channel average". 50 means
 * exactly average; the scale caps at 2× average so one viral upload does
 * not squash every other bar to a sliver.
 */
export function performancePct(views: number, avgViews: number): number {
  if (avgViews <= 0) return views > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, (views / avgViews) * 50));
}

export interface RecentComment extends YouTubeCommentThread {
  videoId: string;
  videoTitle: string;
  videoUrl: string;
}

/**
 * Flatten per-video threads into one feed, newest first. Threads arrive
 * ordered by relevance per video, so the merge has to re-sort by date.
 */
export function mergeRecentComments(
  perVideo: Array<{ video: Pick<YouTubeVideo, "id" | "title" | "url">; threads: YouTubeCommentThread[] }>,
  max = 30,
): RecentComment[] {
  return perVideo
    .flatMap(({ video, threads }) => threads.map((t) => ({ ...t, videoId: video.id, videoTitle: video.title, videoUrl: video.url })))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, max);
}

/**
 * One cache bypass per key per window. The manual Refresh button sends
 * `?fresh=1`; without this a held-down button (or a script) would spend a
 * daily quota unit every few hundred ms.
 */
export class FreshBypassThrottle {
  private last = new Map<string, number>();
  constructor(private windowMs = 20_000, private clock: () => number = Date.now) {}

  /** True (and records the hit) when `key` may bypass the cache now. */
  allow(key: string): boolean {
    const now = this.clock();
    const prev = this.last.get(key) ?? -Infinity;
    if (now - prev < this.windowMs) return false;
    this.last.set(key, now);
    return true;
  }

  /** Seconds until `key` may bypass again; 0 when it may now. */
  retryAfter(key: string): number {
    const prev = this.last.get(key);
    if (prev === undefined) return 0;
    return Math.max(0, Math.ceil((this.windowMs - (this.clock() - prev)) / 1000));
  }
}
