import {
  DRIVER,
  baseValidate,
  graphVersion,
  mockPublish,
  type PlatformAdapter,
  type PublishRequest,
  type PublishResult,
  type RateLimitStatus,
} from "./types";

const GRAPH = "https://graph.facebook.com";

async function graph(
  pathname: string,
  init: { method?: "GET" | "POST"; token: string; params?: Record<string, string> },
): Promise<Record<string, unknown>> {
  const url = new URL(`${GRAPH}/${graphVersion()}/${pathname}`);
  const body = new URLSearchParams({ access_token: init.token, ...(init.params ?? {}) });
  const res =
    init.method === "POST"
      ? await fetch(url, { method: "POST", body })
      : await fetch(`${url}?${body}`);
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = json.error as { message?: string; code?: number } | undefined;
    throw Object.assign(new Error(err?.message ?? `Graph ${res.status}`), {
      status: res.status,
      code: err?.code,
    });
  }
  return json;
}

/** 429 / 5xx / transient Graph codes are worth another attempt; 400s are not. */
function isRetryable(e: unknown): boolean {
  const err = e as { status?: number; code?: number };
  if (err.status === 429 || (err.status ?? 0) >= 500) return true;
  // 4 = app rate limit, 17 = user rate limit, 2 = temporary Graph outage,
  // 9007 = media still transcoding.
  return [4, 17, 2, 9007].includes(err.code ?? -1);
}

/**
 * Instagram publishing is always two calls:
 *   1. POST /{ig-user-id}/media          -> returns a container id
 *   2. POST /{ig-user-id}/media_publish  -> publishes that container
 * Video containers are asynchronous, so between the two we poll
 * GET /{container-id}?fields=status_code until it reports FINISHED.
 */
async function igPublish(req: PublishRequest): Promise<PublishResult> {
  const token = req.connection.accessToken!;
  const igUser = req.connection.externalId;
  const caption = [req.caption, req.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")]
    .filter(Boolean)
    .join("\n\n");

  try {
    let containerId: string;

    if (req.format === "carousel") {
      // Children are created unpublished, then wrapped in a CAROUSEL container.
      const children: string[] = [];
      for (const url of req.mediaUrls) {
        const isVideo = /\.(mp4|mov|m4v)(\?|$)/i.test(url);
        const child = await graph(`${igUser}/media`, {
          method: "POST",
          token,
          params: {
            is_carousel_item: "true",
            ...(isVideo ? { media_type: "VIDEO", video_url: url } : { image_url: url }),
          },
        });
        children.push(String(child.id));
      }
      const container = await graph(`${igUser}/media`, {
        method: "POST",
        token,
        params: { media_type: "CAROUSEL", children: children.join(","), caption },
      });
      containerId = String(container.id);
    } else {
      const mediaType =
        req.format === "reel" ? "REELS" : req.format === "story" ? "STORIES" : undefined;
      const url = req.mediaUrls[0];
      const isVideo = /\.(mp4|mov|m4v)(\?|$)/i.test(url);
      const container = await graph(`${igUser}/media`, {
        method: "POST",
        token,
        params: {
          ...(mediaType ? { media_type: mediaType } : {}),
          ...(isVideo ? { video_url: url } : { image_url: url }),
          // Stories carry no caption; everything else does.
          ...(req.format === "story" ? {} : { caption }),
        },
      });
      containerId = String(container.id);
    }

    // Poll the container. Video transcode is typically 5–60s.
    for (let i = 0; i < 30; i++) {
      const status = await graph(containerId, { token, params: { fields: "status_code,status" } });
      if (status.status_code === "FINISHED") break;
      if (status.status_code === "ERROR") {
        return { ok: false, error: `IG container error: ${String(status.status)}`, retryable: false };
      }
      await new Promise((r) => setTimeout(r, 3000));
    }

    const published = await graph(`${igUser}/media_publish`, {
      method: "POST",
      token,
      params: { creation_id: containerId },
    });
    const externalId = String(published.id);

    if (req.firstComment && req.format !== "story") {
      await graph(`${externalId}/comments`, {
        method: "POST",
        token,
        params: { message: req.firstComment },
      });
    }

    const detail = await graph(externalId, { token, params: { fields: "permalink" } });
    return { ok: true, externalId, permalink: String(detail.permalink ?? "") };
  } catch (e) {
    return { ok: false, error: (e as Error).message, retryable: isRetryable(e) };
  }
}

/**
 * Ask Instagram how much publishing quota is left rather than hardcoding a number.
 * Meta's own docs quote conflicting caps (25 / 50 / 100 per rolling 24h depending
 * on where you read), and the cap differs per account — so the only correct source
 * is the account's own content_publishing_limit edge.
 */
async function igRateLimit(connection: PublishRequest["connection"]): Promise<RateLimitStatus> {
  // Without a live token there is no usage to report, so it reads zero rather
  // than a made-up count — the cap is real, the consumption would not be.
  if (DRIVER === "mock") return { used: 0, quota: 50, windowHours: 24 };
  try {
    const res = await graph(`${connection.externalId}/content_publishing_limit`, {
      token: connection.accessToken!,
      params: { fields: "config,quota_usage" },
    });
    const row = (res.data as Array<Record<string, unknown>>)?.[0] ?? {};
    const config = (row.config ?? {}) as { quota_total?: number; quota_duration?: number };
    return {
      used: Number(row.quota_usage ?? 0),
      quota: Number(config.quota_total ?? 50),
      windowHours: Math.round(Number(config.quota_duration ?? 86400) / 3600),
    };
  } catch {
    return { used: 0, quota: 50, windowHours: 24 };
  }
}

export const instagram: PlatformAdapter = {
  channel: "instagram",
  label: "Instagram",
  color: "#E1306C",
  capabilities: {
    formats: ["feed", "reel", "story", "carousel"],
    captionLimit: 2200,
    hashtagLimit: 30,
    maxMedia: 10,
    supportsStories: true,
    supportsFirstComment: true,
    // IG has no native scheduling via the Graph API — our own queue holds the post.
    supportsNativeScheduling: false,
    supportsStickers: true,
    videoMaxSec: { reel: 900, story: 60, feed: 60 },
    aspectRatios: { reel: ["9:16"], story: ["9:16"], feed: ["1:1", "4:5"], carousel: ["1:1", "4:5"] },
  },
  validate(req) {
    const errors = baseValidate(req, instagram.capabilities, "Instagram");
    if (req.format === "story" && req.mediaUrls.length > 1) {
      errors.push("An Instagram story is one media item — split it into a sequence.");
    }
    if (req.format === "carousel" && req.mediaUrls.length < 2) {
      errors.push("A carousel needs at least 2 items.");
    }
    return errors;
  },
  publish: async (req) => (DRIVER === "mock" ? mockPublish("instagram", req) : igPublish(req)),
  rateLimit: igRateLimit,
};

/**
 * Facebook Pages publish in one call, and — unlike Instagram — the platform can
 * hold the post itself via published=false + scheduled_publish_time, which is
 * more reliable than us holding it (survives our worker being down).
 */
export const facebook: PlatformAdapter = {
  channel: "facebook",
  label: "Facebook",
  color: "#1877F2",
  capabilities: {
    formats: ["feed", "reel", "story", "carousel", "text"],
    captionLimit: 63206,
    hashtagLimit: 30,
    maxMedia: 10,
    supportsStories: true,
    supportsFirstComment: true,
    supportsNativeScheduling: true,
    supportsStickers: false,
    videoMaxSec: { reel: 90, story: 60, feed: 14400 },
    aspectRatios: { reel: ["9:16"], story: ["9:16"], feed: ["1:1", "4:5", "16:9"] },
  },
  validate: (req) => baseValidate(req, facebook.capabilities, "Facebook"),
  async publish(req) {
    if (DRIVER === "mock") return mockPublish("facebook", req);
    const token = req.connection.accessToken!;
    const page = req.connection.externalId;
    const message = [req.caption, req.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ")]
      .filter(Boolean)
      .join("\n\n");
    try {
      const isVideo = /\.(mp4|mov)(\?|$)/i.test(req.mediaUrls[0] ?? "");
      const endpoint = req.mediaUrls.length === 0 ? "feed" : isVideo ? "videos" : "photos";
      const params: Record<string, string> = { ...(endpoint === "videos" ? { description: message } : { message }) };
      if (req.mediaUrls[0]) params[isVideo ? "file_url" : "url"] = req.mediaUrls[0];
      if (req.scheduledAt) {
        params.published = "false";
        params.scheduled_publish_time = String(Math.floor(new Date(req.scheduledAt).getTime() / 1000));
      }
      const res = await graph(`${page}/${endpoint}`, { method: "POST", token, params });
      const externalId = String(res.post_id ?? res.id);
      return { ok: true, externalId, permalink: `https://facebook.com/${externalId}` };
    } catch (e) {
      return { ok: false, error: (e as Error).message, retryable: isRetryable(e) };
    }
  },
  async rateLimit() {
    return { used: 0, quota: 200, windowHours: 1 };
  },
};

export { graph as metaGraph, isRetryable as metaIsRetryable };
