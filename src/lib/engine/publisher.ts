import { mutate, read } from "../db";
import { uid } from "../ids";
import { adapterFor } from "../platforms/registry";
import { isUploadPostConnection, publishViaUploadPost } from "../uploadpost/connections";
import type { Post, PostTarget } from "../types";

/**
 * THE PUBLISH WORKER
 *
 * Called on a tick (cron, or the in-app "Run queue now" button). Everything that
 * makes automated publishing survivable in production lives here:
 *
 *  - Per-target state, not per-post. If Instagram succeeds and TikTok fails, the
 *    post is partially published and only TikTok retries. Re-running the tick can
 *    never double-post to a target that already has an externalId.
 *  - Exponential backoff with a cap, keyed on attempt count on the target.
 *  - Retryable vs. permanent errors come from the adapter, not from string
 *    matching here — a 400 "caption too long" must never be retried forever.
 *  - Rate-limit awareness: before publishing to a channel we ask the adapter for
 *    the account's remaining quota and defer rather than burn an API error.
 */

/**
 * Absolute, fetchable media URL.
 *
 * Every live adapter hands the platform a URL and the *platform* fetches it —
 * Instagram's container creation, TikTok's PULL_FROM_URL, LinkedIn's and X's
 * upload steps all work that way. The render pipeline stores renders as
 * app-relative paths (`/renders/<hash>.mp4`, src/lib/media/render.ts), so
 * passing them through unchanged asks Instagram to resolve a path against its
 * own host. The publish then fails at the platform with an opaque media error,
 * long after the point where the real problem — no public base URL configured —
 * could have been reported.
 *
 * So: pass absolute URLs through untouched, and resolve relative ones against
 * PUBLIC_BASE_URL. When a relative path cannot be resolved the caller reports a
 * permanent, actionable failure rather than letting the platform reject it.
 */
export function publicMediaUrl(pathOrUrl: string): string | null {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  if (!base || !/^https?:\/\//i.test(base)) return null;
  return `${base}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

const MAX_ATTEMPTS = 4;
const BACKOFF_MINUTES = [0, 2, 10, 45];

export interface TickResult {
  checked: number;
  published: number;
  failed: number;
  deferred: number;
  details: Array<{ postId: string; channel: string; ok: boolean; message: string }>;
}

function dueTargets(post: Post, now: Date): PostTarget[] {
  return post.targets.filter((t) => {
    if (t.externalId) return false; // already out
    if (t.status === "published") return false;
    if (t.attempts >= MAX_ATTEMPTS) return false;
    const when = new Date(t.scheduledAt ?? post.scheduledAt ?? 0).getTime();
    const backoff = BACKOFF_MINUTES[Math.min(t.attempts, BACKOFF_MINUTES.length - 1)] * 60_000;
    return when + backoff <= now.getTime();
  });
}

export async function runTick(now = new Date()): Promise<TickResult> {
  const db = read();
  const result: TickResult = { checked: 0, published: 0, failed: 0, deferred: 0, details: [] };

  const candidates = db.posts.filter(
    (p) => ["scheduled", "approved", "publishing", "failed"].includes(p.status) && p.scheduledAt,
  );

  for (const post of candidates) {
    const targets = dueTargets(post, now);
    if (!targets.length) continue;
    result.checked += targets.length;

    for (const target of targets) {
      const adapter = adapterFor(target.channel);
      const connection = db.connections.find((c) => c.id === target.connectionId);
      if (!adapter || !connection) {
        recordFailure(post.id, target.connectionId, "No adapter or connection for this target", false);
        result.failed += 1;
        continue;
      }
      if (connection.status !== "connected") {
        recordDefer(post.id, target.connectionId, `${adapter.label} connection is ${connection.status}`);
        result.deferred += 1;
        result.details.push({ postId: post.id, channel: target.channel, ok: false, message: `connection ${connection.status}` });
        continue;
      }

      // Ask the platform, do not guess: quotas differ per account and per day.
      // Upload-Post-backed connection: one API key, media sent as bytes, so
      // neither the network's quota probe nor a public media URL applies.
      if (isUploadPostConnection(connection)) {
        const refs = post.mediaIds
          .map((id) => db.media.find((m) => m.id === id))
          .filter(Boolean)
          .map((m) => {
            const wanted = adapter.capabilities.aspectRatios[target.format]?.[0];
            return (wanted && m!.renders[wanted]) || m!.src;
          });
        const res = await publishViaUploadPost(target.channel, {
          connection: { id: connection.id, externalId: connection.externalId, accessToken: undefined, handle: connection.handle },
          format: target.format,
          caption: target.caption ?? post.caption,
          hashtags: post.hashtags,
          mediaUrls: refs,
          stickers: target.stickers,
          firstComment: target.firstComment,
        });
        if (res.ok) {
          recordSuccess(post.id, target.connectionId, res.externalId!, res.permalink);
          result.published += 1;
          result.details.push({ postId: post.id, channel: target.channel, ok: true, message: res.permalink ?? res.externalId! });
        } else {
          recordFailure(post.id, target.connectionId, res.error ?? "unknown error", res.retryable ?? false);
          result.failed += 1;
          result.details.push({ postId: post.id, channel: target.channel, ok: false, message: res.error ?? "error" });
        }
        continue;
      }

      const quota = await adapter.rateLimit({
        id: connection.id,
        externalId: connection.externalId,
        accessToken: connection.accessToken,
        handle: connection.handle,
      });
      if (quota.used >= quota.quota) {
        recordDefer(post.id, target.connectionId, `${adapter.label} quota exhausted (${quota.used}/${quota.quota} per ${quota.windowHours}h)`);
        result.deferred += 1;
        result.details.push({ postId: post.id, channel: target.channel, ok: false, message: "rate limited" });
        continue;
      }

      const rawMedia = post.mediaIds
        .map((id) => db.media.find((m) => m.id === id))
        .filter(Boolean)
        .map((m) => {
          // Prefer a render matching the platform's required aspect ratio.
          const wanted = adapter.capabilities.aspectRatios[target.format]?.[0];
          return (wanted && m!.renders[wanted]) || m!.src;
        });

      // Resolve before dispatch so an unreachable file is reported here, with a
      // fixable message, instead of as a platform-side media error.
      const media: string[] = [];
      let unresolvable: string | null = null;
      for (const raw of rawMedia) {
        const abs = publicMediaUrl(raw);
        if (!abs) {
          unresolvable = raw;
          break;
        }
        media.push(abs);
      }
      if (unresolvable) {
        recordFailure(
          post.id,
          target.connectionId,
          `Cannot publish: "${unresolvable}" is a local path and PUBLIC_BASE_URL is not set to a public https address. ${adapter.label} fetches media by URL, so it must be reachable from the internet.`,
          false,
        );
        result.failed += 1;
        result.details.push({ postId: post.id, channel: target.channel, ok: false, message: "media not publicly reachable" });
        continue;
      }

      const res = await adapter.publish({
        connection: {
          id: connection.id,
          externalId: connection.externalId,
          accessToken: connection.accessToken,
          handle: connection.handle,
        },
        format: target.format,
        caption: target.caption ?? post.caption,
        hashtags: post.hashtags,
        mediaUrls: media,
        stickers: target.stickers,
        firstComment: target.firstComment,
        scheduledAt: adapter.capabilities.supportsNativeScheduling ? (target.scheduledAt ?? post.scheduledAt) : undefined,
      });

      if (res.ok) {
        recordSuccess(post.id, target.connectionId, res.externalId!, res.permalink);
        result.published += 1;
        result.details.push({ postId: post.id, channel: target.channel, ok: true, message: res.permalink ?? res.externalId! });
      } else {
        recordFailure(post.id, target.connectionId, res.error ?? "unknown error", res.retryable ?? false);
        result.failed += 1;
        result.details.push({ postId: post.id, channel: target.channel, ok: false, message: res.error ?? "error" });
      }
    }
  }
  return result;
}

function updateTarget(postId: string, connectionId: string, fn: (t: PostTarget, p: Post) => void): void {
  mutate((db) => {
    const post = db.posts.find((p) => p.id === postId);
    const target = post?.targets.find((t) => t.connectionId === connectionId);
    if (!post || !target) return;
    fn(target, post);

    // Roll the post-level status up from its targets.
    const done = post.targets.every((t) => t.status === "published");
    const anyFailed = post.targets.some((t) => t.status === "failed");
    post.status = done ? "published" : anyFailed ? "failed" : "publishing";
    if (done && !post.publishedAt) post.publishedAt = new Date().toISOString();
    post.updatedAt = new Date().toISOString();
  });
}

function recordSuccess(postId: string, connectionId: string, externalId: string, permalink?: string): void {
  updateTarget(postId, connectionId, (t, p) => {
    t.status = "published";
    t.externalId = externalId;
    t.permalink = permalink;
    t.error = undefined;
    t.attempts += 1;
    logActivity(p.brandId, "publish", `Published to ${t.channel}${permalink ? ` — ${permalink}` : ""}`);
  });
}

function recordFailure(postId: string, connectionId: string, error: string, retryable: boolean): void {
  updateTarget(postId, connectionId, (t, p) => {
    t.attempts += 1;
    t.error = error;
    // A permanent error, or the last attempt, stops the retry loop for good.
    t.status = !retryable || t.attempts >= MAX_ATTEMPTS ? "failed" : "scheduled";
    logActivity(
      p.brandId,
      "publish_error",
      `${t.channel} failed (attempt ${t.attempts}/${MAX_ATTEMPTS}): ${error}${t.status === "failed" ? " — giving up" : " — will retry"}`,
    );
  });
}

function recordDefer(postId: string, connectionId: string, reason: string): void {
  updateTarget(postId, connectionId, (t, p) => {
    t.error = reason;
    logActivity(p.brandId, "publish_deferred", `${t.channel} deferred: ${reason}`);
  });
}

export function logActivity(brandId: string, kind: string, message: string, actor: string = "system"): void {
  mutate((db) => {
    db.activity.unshift({ id: uid("act"), brandId, at: new Date().toISOString(), actor, kind, message });
    db.activity = db.activity.slice(0, 500);
  });
}
