/**
 * YOUTUBE DATA API v3 — PUBLIC (API-KEY) READS
 *
 * Everything here is what any browser can see on youtube.com: channel stats,
 * the uploads list, per-video counts and public comment threads. It needs no
 * OAuth grant, which is why it works for Upload-Post-backed connections that
 * carry no access token of their own.
 *
 * What it can NOT give: impressions, CTR, watch time, traffic sources. Those
 * live in the YouTube Analytics API, which only answers to the channel owner
 * (Google OAuth client + youtube.readonly / yt-analytics.readonly scopes).
 *
 * Nothing exported here throws to a caller. Quota exhaustion, a missing key
 * or an unknown handle come back as a typed `YouTubeError` (or `null` from
 * `fetchYouTubeSnapshot`), because a dashboard panel that 500s on a quota
 * blip is worse than one that says "quota exceeded".
 */

import { mergeRecentComments, type RecentComment } from "./studio";

const API = "https://www.googleapis.com/youtube/v3";
// Longer than the panel's 30s poll so background polls are served warm and
// only the throttled `?fresh=1` (manual refresh) spends quota. 15s here meant
// every poll was a live 3-unit read — ~400 units/viewer-hour against 10k/day.
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Key resolution: a dedicated YOUTUBE_API_KEY wins; otherwise fall back to
 * GOOGLE_SHEETS_API_KEY. That key is a plain Google Cloud API key, and the
 * project it belongs to has the YouTube Data API enabled, so the same
 * credential serves both. A separate var lets an operator split them later
 * without touching this code.
 */
export function youtubeApiKey(): string | undefined {
  return (process.env.YOUTUBE_API_KEY ?? process.env.GOOGLE_SHEETS_API_KEY)?.trim() || undefined;
}

export function isYouTubeConfigured(): boolean {
  return Boolean(youtubeApiKey());
}

export type YouTubeErrorCode = "not_configured" | "quota_exceeded" | "not_found" | "comments_disabled" | "forbidden" | "http" | "network";

export class YouTubeError extends Error {
  /** `reason` is Google's own error tag (quotaExceeded, playlistNotFound, …) when the body carried one. */
  constructor(public code: YouTubeErrorCode, message: string, public status?: number, public reason?: string) {
    super(message);
    this.name = "YouTubeError";
  }
}

/** Google error messages embed markup (`<code>playlistId</code>`); the panel renders them as text. */
const stripTags = (s: string): string => s.replace(/<[^>]*>/g, "");

export interface YouTubeChannel {
  channelId: string;
  title: string;
  handle: string;
  uploadsPlaylistId: string;
  thumbnail?: string;
  stats: { views: number; subscribers: number; videos: number; hiddenSubscriberCount: boolean };
}

export interface YouTubeVideo {
  id: string;
  title: string;
  publishedAt: string;
  thumbnail?: string;
  /** Seconds, parsed from ISO-8601 (PT1H2M3S). */
  duration: number;
  views: number;
  likes: number;
  comments: number;
  url: string;
}

export interface YouTubeCommentThread {
  id: string;
  author: string;
  authorAvatar?: string;
  text: string;
  likeCount: number;
  publishedAt: string;
  replies: number;
}

export interface YouTubeSnapshot {
  channel: YouTubeChannel;
  videos: YouTubeVideo[];
  fetchedAt: string;
}

/* ------------------------------------------------------------------ */
/* Raw payload shapes (only the fields we read)                         */
/* ------------------------------------------------------------------ */

type Thumbs = Record<string, { url: string; width?: number; height?: number } | undefined>;

export interface RawChannelList {
  items?: Array<{
    id: string;
    snippet?: { title?: string; customUrl?: string; thumbnails?: Thumbs };
    contentDetails?: { relatedPlaylists?: { uploads?: string } };
    statistics?: { viewCount?: string; subscriberCount?: string; hiddenSubscriberCount?: boolean; videoCount?: string };
  }>;
}

export interface RawPlaylistItems {
  nextPageToken?: string;
  items?: Array<{ contentDetails?: { videoId?: string } }>;
}

export interface RawVideoList {
  items?: Array<{
    id: string;
    snippet?: { title?: string; publishedAt?: string; thumbnails?: Thumbs };
    contentDetails?: { duration?: string };
    statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  }>;
}

export interface RawCommentThreads {
  items?: Array<{
    id: string;
    snippet?: {
      totalReplyCount?: number;
      topLevelComment?: {
        snippet?: {
          authorDisplayName?: string;
          authorProfileImageUrl?: string;
          textDisplay?: string;
          textOriginal?: string;
          likeCount?: number;
          publishedAt?: string;
        };
      };
    };
  }>;
}

/* ------------------------------------------------------------------ */
/* Mapping (pure; unit-tested against captured payloads)               */
/* ------------------------------------------------------------------ */

const num = (v: string | number | undefined): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Largest thumbnail YouTube offers for the item; 16:9 sizes sort after 4:3 ones. */
function bestThumb(t?: Thumbs): string | undefined {
  if (!t) return undefined;
  for (const k of ["maxres", "standard", "high", "medium", "default"]) {
    const u = t[k]?.url;
    if (u) return u;
  }
  return undefined;
}

/** ISO-8601 duration → seconds. YouTube emits PT#H#M#S, and P#D for the rare long upload. */
export function parseDuration(iso: string | undefined): number {
  if (!iso) return 0;
  const m = iso.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  const [, d, h, mi, s] = m.map((x) => Number(x ?? 0));
  return d * 86400 + h * 3600 + mi * 60 + s;
}

export function mapChannel(raw: RawChannelList): YouTubeChannel | null {
  const c = raw.items?.[0];
  if (!c?.id) return null;
  return {
    channelId: c.id,
    title: c.snippet?.title ?? "",
    handle: c.snippet?.customUrl ?? "",
    // `uploads` is deterministic (UC… → UU…) but we still read it from the
    // payload rather than derive it, so a change on Google's side cannot
    // silently point us at an empty playlist.
    uploadsPlaylistId: c.contentDetails?.relatedPlaylists?.uploads ?? `UU${c.id.slice(2)}`,
    thumbnail: bestThumb(c.snippet?.thumbnails),
    stats: {
      views: num(c.statistics?.viewCount),
      subscribers: num(c.statistics?.subscriberCount),
      videos: num(c.statistics?.videoCount),
      hiddenSubscriberCount: Boolean(c.statistics?.hiddenSubscriberCount),
    },
  };
}

export function mapVideos(raw: RawVideoList): YouTubeVideo[] {
  return (raw.items ?? [])
    .filter((v) => v.id)
    .map((v) => ({
      id: v.id,
      title: v.snippet?.title ?? "",
      publishedAt: v.snippet?.publishedAt ?? "",
      thumbnail: bestThumb(v.snippet?.thumbnails),
      duration: parseDuration(v.contentDetails?.duration),
      views: num(v.statistics?.viewCount),
      likes: num(v.statistics?.likeCount),
      // commentCount is absent when the owner disabled comments; 0 is the honest reading.
      comments: num(v.statistics?.commentCount),
      url: `https://www.youtube.com/watch?v=${v.id}`,
    }));
}

export function mapComments(raw: RawCommentThreads): YouTubeCommentThread[] {
  return (raw.items ?? []).flatMap((t) => {
    const s = t.snippet?.topLevelComment?.snippet;
    if (!s) return [];
    return [{
      id: t.id,
      author: s.authorDisplayName ?? "",
      authorAvatar: s.authorProfileImageUrl,
      // textOriginal is the plain text; textDisplay carries HTML we would have to sanitise.
      text: s.textOriginal ?? s.textDisplay ?? "",
      likeCount: num(s.likeCount),
      publishedAt: s.publishedAt ?? "",
      replies: num(t.snippet?.totalReplyCount),
    }];
  });
}

/* ------------------------------------------------------------------ */
/* Transport + cache                                                    */
/* ------------------------------------------------------------------ */

const cache = new Map<string, { at: number; value: unknown }>();

/** Tests and the daily sync can drop the cache to force a re-read. */
export function clearYouTubeCache(): void {
  cache.clear();
}

/**
 * One GET against the Data API, cached by URL for CACHE_TTL_MS (5 min) unless
 * the caller passes its own ttlMs, or `fresh` to bypass the read.
 *
 * The daily quota is 10 000 units and every list call costs one; a channel
 * page that re-fetches on each render would burn through that in an afternoon
 * of someone refreshing. Errors are not cached — a quota error at 23:59 should
 * not still be served at 00:05 after the reset.
 */
const FETCH_TIMEOUT_MS = 15_000;

async function api<T>(path: string, params: Record<string, string | number | undefined>, opts: { ttlMs?: number; fresh?: boolean } = {}): Promise<T> {
  const key = youtubeApiKey();
  if (!key) throw new YouTubeError("not_configured", "YouTube is not configured. Set YOUTUBE_API_KEY (or GOOGLE_SHEETS_API_KEY) with the YouTube Data API enabled.");

  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  const cacheKey = url.toString();
  const hit = cache.get(cacheKey);
  // `fresh` skips the read but still writes, so the next poll is served warm.
  if (!opts.fresh && hit && Date.now() - hit.at < (opts.ttlMs ?? CACHE_TTL_MS)) return hit.value as T;

  url.searchParams.set("key", key);
  let res: Response;
  try {
    // Hard cap: undici's default header timeout is minutes, far longer than any page should wait.
    res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    throw new YouTubeError("network", `YouTube unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!res.ok) {
    let reason = "";
    let message = `YouTube API ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string; errors?: Array<{ reason?: string }> } };
      reason = body.error?.errors?.[0]?.reason ?? "";
      message = stripTags(body.error?.message ?? message);
    } catch { /* non-JSON error body: keep the status text */ }
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded" || reason === "rateLimitExceeded") {
      throw new YouTubeError("quota_exceeded", "YouTube Data API quota exceeded for today; figures resume after the midnight-Pacific reset.", res.status);
    }
    if (reason === "commentsDisabled") throw new YouTubeError("comments_disabled", "Comments are turned off on this video.", res.status);
    if (res.status === 403) throw new YouTubeError("forbidden", message, res.status, reason);
    if (res.status === 404) throw new YouTubeError("not_found", message, res.status, reason);
    throw new YouTubeError("http", message, res.status, reason);
  }

  const value = (await res.json()) as T;
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}

/* ------------------------------------------------------------------ */
/* Public surface                                                       */
/* ------------------------------------------------------------------ */

/**
 * What to hand `resolveChannel` for a stored YouTube connection. Native
 * Google-OAuth rows store the channel TITLE in `handle` (exchange.ts keeps the
 * display name for the UI) and the channel id in `externalId`; `forHandle=`
 * answers an empty list for a title like "Kiwik One", so the id has to win
 * whenever we hold one. Upload-Post rows carry the profile handle only.
 */
export function youtubeChannelRef(conn: { externalId?: string | null; handle?: string | null }): string {
  const id = conn.externalId?.trim() ?? "";
  if (/^UC[\w-]{20,}$/.test(id)) return id;
  return conn.handle ?? "";
}

/** "@kiwik-one" | "kiwik-one" | a UC… id → channel. Throws YouTubeError only. */
export async function resolveChannel(handle: string, opts: { fresh?: boolean } = {}): Promise<YouTubeChannel> {
  const h = handle.trim().replace(/^@/, "");
  const params = /^UC[\w-]{20,}$/.test(h)
    ? { id: h }
    : { forHandle: h };
  const raw = await api<RawChannelList>("channels", { part: "snippet,contentDetails,statistics", ...params }, opts);
  const channel = mapChannel(raw);
  // The API answers 200 with an empty list for an unknown handle, so "not
  // found" has to be decided here rather than from the status code.
  if (!channel) throw new YouTubeError("not_found", `No YouTube channel for handle "${handle}".`);
  return channel;
}

/**
 * Every upload on the channel (newest first), with counts.
 *
 * playlistItems gives ids only; the counts need a second call to videos,
 * which accepts 50 ids at a time — so each page of 50 uploads costs 2 units.
 *
 * A channel that has never uploaded has no uploads playlist at all: Google
 * answers 404 playlistNotFound rather than an empty page. That is "no videos
 * yet", not an error, so it comes back as `[]`.
 */
export async function listUploads(channelId: string, max = 50, opts: { fresh?: boolean } = {}): Promise<YouTubeVideo[]> {
  const uploads = `UU${channelId.replace(/^UC/, "")}`;
  const out: YouTubeVideo[] = [];
  let pageToken: string | undefined;
  while (out.length < max) {
    let page: RawPlaylistItems;
    try {
      page = await api<RawPlaylistItems>("playlistItems", {
        part: "contentDetails",
        playlistId: uploads,
        maxResults: Math.min(50, max - out.length),
        pageToken,
      }, opts);
    } catch (e) {
      if (e instanceof YouTubeError && e.reason === "playlistNotFound") return out;
      throw e;
    }
    const ids = (page.items ?? []).map((i) => i.contentDetails?.videoId).filter((x): x is string => Boolean(x));
    if (ids.length === 0) break;
    const vids = await api<RawVideoList>("videos", { part: "snippet,contentDetails,statistics", id: ids.join(","), maxResults: 50 }, opts);
    // Keep playlist order (newest first); videos.list does not promise it.
    const byId = new Map(mapVideos(vids).map((v) => [v.id, v]));
    for (const id of ids) {
      const v = byId.get(id);
      if (v) out.push(v);
    }
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }
  return out.slice(0, max);
}

/** Top-level public comment threads on one video, most relevant first. */
export async function listComments(videoId: string, max = 50): Promise<YouTubeCommentThread[]> {
  const out: YouTubeCommentThread[] = [];
  let pageToken: string | undefined;
  while (out.length < max) {
    const page = await api<RawCommentThreads & { nextPageToken?: string }>("commentThreads", {
      part: "snippet",
      videoId,
      maxResults: Math.min(100, max - out.length),
      textFormat: "plainText",
      order: "relevance",
      pageToken,
    });
    const threads = mapComments(page);
    out.push(...threads);
    pageToken = page.nextPageToken;
    if (!pageToken || threads.length === 0) break;
  }
  return out.slice(0, max);
}

/**
 * The one-call read the daily stats sync and the channel page both use.
 *
 * `null` means "nothing to show" for any reason — no key, no such handle,
 * quota gone, network down. Callers that need to tell those apart use
 * `fetchYouTubeSnapshotResult` and branch on the error code; the daily
 * sync just wants to know whether it has numbers to record.
 */
export async function fetchYouTubeSnapshot(handle: string): Promise<YouTubeSnapshot | null> {
  const r = await fetchYouTubeSnapshotResult(handle);
  return r.ok ? r.snapshot : null;
}

export type YouTubeSnapshotResult =
  | { ok: true; snapshot: YouTubeSnapshot }
  | { ok: false; code: YouTubeErrorCode; error: string };

/** `fresh` bypasses the read cache (one round of quota); callers rate-limit it per brand. */
export async function fetchYouTubeSnapshotResult(handle: string, opts: { fresh?: boolean } = {}): Promise<YouTubeSnapshotResult> {
  try {
    const channel = await resolveChannel(handle, opts);
    // Zero uploads: skip the playlist call (it would 404) and save the quota unit.
    const videos = channel.stats.videos === 0 ? [] : await listUploads(channel.channelId, 50, opts);
    return { ok: true, snapshot: { channel, videos, fetchedAt: new Date().toISOString() } };
  } catch (e) {
    return toResult(e);
  }
}

export async function fetchYouTubeComments(videoId: string, max = 50): Promise<
  { ok: true; threads: YouTubeCommentThread[] } | { ok: false; code: YouTubeErrorCode; error: string }
> {
  try {
    return { ok: true, threads: await listComments(videoId, max) };
  } catch (e) {
    return toResult(e);
  }
}

/** Recent-comments feed keeps its own, longer TTL: it costs one unit per video per read. */
const RECENT_COMMENTS_TTL_MS = 2 * 60 * 1000;

/**
 * Newest top-level comments across the latest `videoCount` uploads — the
 * "Comments" feed on the Studio dashboard. One commentThreads call per
 * video (order=time, small page), cached 2 minutes. A video with comments
 * disabled contributes nothing rather than failing the whole feed.
 */
export async function fetchYouTubeRecentComments(
  videos: Array<Pick<YouTubeVideo, "id" | "title" | "url" | "comments">>,
  videoCount = 10,
  perVideo = 10,
): Promise<{ ok: true; comments: RecentComment[] } | { ok: false; code: YouTubeErrorCode; error: string }> {
  try {
    const perVideoThreads = await Promise.all(
      // commentCount 0 → skip the call; nothing to read and the unit is better spent elsewhere.
      videos.slice(0, videoCount).filter((v) => v.comments > 0).map(async (video) => {
        try {
          const page = await api<RawCommentThreads>("commentThreads", {
            part: "snippet", videoId: video.id, maxResults: perVideo, textFormat: "plainText", order: "time",
          }, { ttlMs: RECENT_COMMENTS_TTL_MS });
          return { video, threads: mapComments(page) };
        } catch (e) {
          if (e instanceof YouTubeError && e.code === "comments_disabled") return { video, threads: [] };
          throw e;
        }
      }),
    );
    return { ok: true, comments: mergeRecentComments(perVideoThreads) };
  } catch (e) {
    return toResult(e);
  }
}

function toResult(e: unknown): { ok: false; code: YouTubeErrorCode; error: string } {
  if (e instanceof YouTubeError) return { ok: false, code: e.code, error: e.message };
  return { ok: false, code: "network", error: e instanceof Error ? e.message : String(e) };
}
