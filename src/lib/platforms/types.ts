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

/**
 * The driver, resolved once and fail-closed.
 *
 * This was an unchecked cast of the raw env var, and every call site then asked
 * `DRIVER === "mock" ? mock : live`. Those two facts together meant anything
 * that was not exactly the string "mock" selected the LIVE path — including the
 * empty string, which `?? "mock"` does not catch because it is not nullish, and
 * including "Live", "LIVE" and any typo. A blank or misspelled PLATFORM_DRIVER
 * therefore published real posts to real accounts.
 *
 * Live is now opt-in by exact match and everything else degrades to mock, so the
 * failure mode of a misconfiguration is "nothing was published" rather than
 * "something was published that nobody intended".
 */
export const DRIVER: "mock" | "live" =
  process.env.PLATFORM_DRIVER?.trim().toLowerCase() === "live" ? "live" : "mock";

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
 * The not-live publish path. Every adapter falls back to it, and it always fails.
 *
 * Nothing leaves the process here, so returning success would mean inventing the
 * external id and permalink that a real publish returns — and that invention does
 * not stay local. The target is recorded as published, the calendar shows the post
 * as out, analytics counts it, and the permalink leads nowhere. A failure is the
 * only result that matches what actually happened.
 *
 * The failure is permanent by construction: no number of attempts turns a missing
 * credential or a missing adapter into a published post. Marking it retryable would
 * only spend the publisher's backoff budget and bury the real cause under four
 * identical errors, so `retryable` is false and the message names the one thing an
 * operator has to change.
 */
export function mockPublish(channel: string, req: PublishRequest): PublishResult {
  const account = req.connection.handle ? ` as ${req.connection.handle}` : "";
  const reason =
    DRIVER === "live"
      ? `this build has no live ${channel} API integration, so it cannot publish even with PLATFORM_DRIVER=live`
      : `publishing is running with PLATFORM_DRIVER="${DRIVER}" — set PLATFORM_DRIVER=live and configure ${channel} API credentials, then re-queue this post`;
  return {
    ok: false,
    error: `Nothing was sent to ${channel}${account}: ${reason}.`,
    retryable: false,
  };
}
