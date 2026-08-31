import type { ChannelId, PostFormat, StorySticker } from "../types";

/**
 * Every network is reached through this one interface. The publisher, the metric
 * sync and the UI only ever talk to `PlatformAdapter` — so adding TikTok or
 * Pinterest later is a new file in this folder plus one registry line, and zero
 * changes anywhere else.
 */

export interface PublishRequest {
  connection: { id: string; externalId: string; accessToken?: string; handle: string };
  format: PostFormat;
  caption: string;
  hashtags: string[];
  /** Publicly reachable media URLs. Meta pulls media from a URL, it does not accept uploads. */
  mediaUrls: string[];
  stickers?: StorySticker[];
  firstComment?: string;
  /** ISO. When set and the platform supports it, hand scheduling to the platform. */
  scheduledAt?: string;
}

export interface PublishResult {
  ok: boolean;
  externalId?: string;
  permalink?: string;
  error?: string;
  /** True when the failure is worth retrying (429/5xx/network) vs. permanent (400). */
  retryable?: boolean;
}

export interface RateLimitStatus {
  /** Posts already published in the rolling window. */
  used: number;
  /** Platform-reported cap. Read from the API where possible, never hardcoded. */
  quota: number;
  windowHours: number;
}

export interface PlatformCapabilities {
  formats: PostFormat[];
  /** Hard character cap the composer enforces before you can schedule. */
  captionLimit: number;
  hashtagLimit: number;
  maxMedia: number;
  supportsStories: boolean;
  supportsFirstComment: boolean;
  /** The platform itself can hold a scheduled post (vs. us holding it). */
  supportsNativeScheduling: boolean;
  supportsStickers: boolean;
  videoMaxSec: Partial<Record<PostFormat, number>>;
  aspectRatios: Partial<Record<PostFormat, string[]>>;
}

export interface PlatformAdapter {
  channel: ChannelId;
  label: string;
  color: string;
  capabilities: PlatformCapabilities;
  publish(req: PublishRequest): Promise<PublishResult>;
  /** Ask the platform how much of the publishing quota is left. */
  rateLimit(connection: PublishRequest["connection"]): Promise<RateLimitStatus>;
  /** Validate before scheduling so failures surface in the composer, not at 6am. */
  validate(req: Omit<PublishRequest, "connection">): string[];
}

export const DRIVER = (process.env.PLATFORM_DRIVER ?? "mock") as "mock" | "live";

export function graphVersion(): string {
  return process.env.META_GRAPH_VERSION ?? "v23.0";
}

/** Shared validation used by every adapter before its own extra rules. */
export function baseValidate(
  req: Omit<PublishRequest, "connection">,
  caps: PlatformCapabilities,
  label: string,
): string[] {
  const errors: string[] = [];
  const full = [req.caption, ...req.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`))].join(" ").trim();
  if (!caps.formats.includes(req.format)) {
    errors.push(`${label} does not support ${req.format} posts.`);
  }
  if (full.length > caps.captionLimit) {
    errors.push(`${label} caption is ${full.length} chars, limit is ${caps.captionLimit}.`);
  }
  if (req.hashtags.length > caps.hashtagLimit) {
    errors.push(`${label} allows ${caps.hashtagLimit} hashtags, you have ${req.hashtags.length}.`);
  }
  if (req.mediaUrls.length > caps.maxMedia) {
    errors.push(`${label} accepts ${caps.maxMedia} media items, you attached ${req.mediaUrls.length}.`);
  }
  if (req.format !== "text" && req.mediaUrls.length === 0) {
    errors.push(`${label} ${req.format} posts need at least one media file.`);
  }
  if (req.stickers?.length && !caps.supportsStickers) {
    errors.push(`${label} does not support interactive stickers.`);
  }
  return errors;
}

/**
 * Deterministic simulated publish. Fails ~4% of the time (retryable) so the
 * retry/backoff path in the publisher is exercised in demo mode instead of only
 * in production at 3am.
 */
export function mockPublish(channel: string, req: PublishRequest): PublishResult {
  const hash = [...`${channel}:${req.caption}:${req.mediaUrls.join(",")}`].reduce(
    (a, c) => (a * 31 + c.charCodeAt(0)) % 100000,
    7,
  );
  if (hash % 25 === 0) {
    return { ok: false, error: `${channel}: media container processing timed out`, retryable: true };
  }
  const externalId = `${channel}_${hash.toString(36)}${Date.now().toString(36).slice(-4)}`;
  return {
    ok: true,
    externalId,
    permalink: `https://example.invalid/${channel}/${externalId}`,
  };
}
