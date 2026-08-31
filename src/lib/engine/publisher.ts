import { mutate, read } from "../db";
import { uid } from "../ids";
import { adapterFor } from "../platforms/registry";
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

      const media = post.mediaIds
        .map((id) => db.media.find((m) => m.id === id))
        .filter(Boolean)
        .map((m) => {
          // Prefer a render matching the platform's required aspect ratio.
          const wanted = adapter.capabilities.aspectRatios[target.format]?.[0];
          return (wanted && m!.renders[wanted]) || m!.src;
        });

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
