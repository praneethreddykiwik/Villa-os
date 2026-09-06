import fs from "node:fs/promises";
import path from "node:path";
import { adminClient, hasServiceRole, isSupabaseConfigured } from "../supabase/client";
import { isStorageSrc, resolveSrc } from "../media/store";
import type { ChannelId } from "../types";
import type { PublishRequest, PublishResult } from "../platforms/types";
import {
  checkUploadPostStatus,
  isUploadPostConfigured,
  uploadPostPhotos,
  uploadPostUser,
  uploadPostVideo,
  type SocialAccountInfo,
} from "./client";

/**
 * UPLOAD-POST BACKED CONNECTIONS
 *
 * The app's own connect flow is OAuth: each network needs its own developer
 * app and client credentials, and the token lands in `connections`. Upload-Post
 * is the alternative this deployment actually uses — the networks are linked
 * once in the Upload-Post dashboard and one API key publishes to all of them.
 *
 * Before this module the two never met: the validation layer accepted an
 * Upload-Post-backed row, but nothing created one, so every channel read
 * "not connected" and the composer had nothing to target. A connection here is
 * a row whose `externalId` carries the `uploadpost:` prefix; the publisher
 * recognises that prefix and sends media through Upload-Post instead of the
 * network's own API.
 */

export const UPLOAD_POST_PREFIX = "uploadpost:";

/** App channel → Upload-Post platform key. */
export const UPLOAD_POST_PLATFORM: Partial<Record<ChannelId, string>> = {
  instagram: "instagram",
  youtube: "youtube",
  facebook: "facebook",
  linkedin: "linkedin",
  tiktok: "tiktok",
  x: "x",
  google_business: "google_business",
};

export function isUploadPostConnection(c: { externalId?: string }): boolean {
  return Boolean(c.externalId?.startsWith(UPLOAD_POST_PREFIX));
}

export function uploadPostExternalId(channel: ChannelId): string {
  return `${UPLOAD_POST_PREFIX}${uploadPostUser()}:${UPLOAD_POST_PLATFORM[channel] ?? channel}`;
}

/** The account linked for this channel in the Upload-Post profile, if any. */
export async function uploadPostLinkedAccount(channel: ChannelId): Promise<SocialAccountInfo | null> {
  const platform = UPLOAD_POST_PLATFORM[channel];
  if (!platform || !isUploadPostConfigured()) return null;
  const status = await checkUploadPostStatus();
  if (!status.valid) return null;
  const profile = status.profiles.find((p) => p.username === status.activeProfile) ?? status.profiles[0];
  const raw = profile?.social_accounts?.[platform];
  if (!raw || typeof raw !== "object") return null;
  return raw.handle || raw.display_name ? raw : null;
}

/* -------------------------------------------------------------------------- */
/* Publishing                                                                  */
/* -------------------------------------------------------------------------- */

const VIDEO_RE = /\.(mp4|mov|m4v|webm)(\?|$)/i;

/**
 * Turn a media reference into something Upload-Post can take: a public URL, or
 * the file's bytes. Local paths under /public are read directly, so publishing
 * through Upload-Post does not need PUBLIC_BASE_URL — the one hard requirement
 * of the native adapters that a localhost deployment can never satisfy.
 */
async function loadMedia(ref: string): Promise<{ value: string | Buffer; filename: string } | null> {
  const filename = path.basename(ref.split("?")[0]) || "media";
  if (/^https?:\/\//i.test(ref)) return { value: ref, filename };
  if (isStorageSrc(ref)) {
    if (!isSupabaseConfigured() || !hasServiceRole()) return null;
    const url = await resolveSrc(adminClient(), ref);
    return url ? { value: url, filename } : null;
  }
  const publicDir = path.join(process.cwd(), "public");
  const local = path.resolve(publicDir, ref.replace(/^\/+/, ""));
  // Never read outside the public tree, whatever the stored path says. The
  // separator is part of the prefix: a bare `startsWith(publicDir)` also
  // accepted `../public-archive/...`, i.e. any sibling whose name begins with
  // "public".
  if (!local.startsWith(publicDir + path.sep)) return null;
  try {
    return { value: await fs.readFile(local), filename };
  } catch {
    return null;
  }
}

function pickId(data: unknown, platform: string): { externalId: string; permalink?: string } {
  const d = (data ?? {}) as Record<string, unknown>;
  const results = (d.results ?? d.result ?? {}) as Record<string, unknown>;
  const mine = (results[platform] ?? {}) as Record<string, unknown>;
  const externalId = String(mine.id ?? mine.post_id ?? mine.video_id ?? d.request_id ?? d.id ?? `uploadpost-${Date.now()}`);
  const permalink = typeof mine.url === "string" ? mine.url : typeof mine.permalink === "string" ? mine.permalink : undefined;
  return { externalId, permalink };
}

export async function publishViaUploadPost(channel: ChannelId, req: PublishRequest): Promise<PublishResult> {
  const platform = UPLOAD_POST_PLATFORM[channel];
  if (!platform) return { ok: false, error: `${channel} cannot publish through the publishing connector.`, retryable: false };
  if (!isUploadPostConfigured()) return { ok: false, error: "The publishing connector is not configured.", retryable: false };

  const hashtags = req.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ");
  const description = [req.caption, hashtags].filter(Boolean).join("\n\n");
  const title = (req.caption.split("\n")[0] || description).slice(0, 100);

  if (!req.mediaUrls.length) {
    return { ok: false, error: "The publishing connector needs a video or at least one image — text-only posts are not supported on this path.", retryable: false };
  }

  const loaded = [];
  for (const ref of req.mediaUrls) {
    const m = await loadMedia(ref);
    if (!m) return { ok: false, error: `Could not read media "${ref}" for the publishing connector.`, retryable: false };
    loaded.push({ ...m, isVideo: VIDEO_RE.test(ref) });
  }

  const video = loaded.find((m) => m.isVideo);
  const res = video
    ? await uploadPostVideo({
        platforms: [platform],
        video: video.value,
        filename: video.filename,
        title,
        description,
        mediaType: req.format === "story" ? "STORIES" : req.format === "reel" || req.format === "short" ? "REELS" : undefined,
      })
    : await uploadPostPhotos({
        platforms: [platform],
        photos: loaded.map((m) => m.value),
        title,
        description,
      });

  if (!res.ok) {
    const msg = res.error ?? "Publishing connector publish failed";
    // Rate limits and upstream outages are worth another attempt; rejected media is not.
    const retryable = /429|rate|timeout|5\d\d|temporar/i.test(msg);
    return { ok: false, error: msg, retryable };
  }
  const { externalId, permalink } = pickId(res.data, platform);
  return { ok: true, externalId, permalink };
}
