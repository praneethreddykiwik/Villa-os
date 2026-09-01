import { NextResponse } from "next/server";
import { mutate, read } from "@/lib/db";
import { uid } from "@/lib/ids";
import { adapterFor } from "@/lib/platforms/registry";
import { logActivity } from "@/lib/engine/publisher";
import type { Post, PostFormat, PostTarget } from "@/lib/types";
import { guard } from "@/lib/auth/guard";

/**
 * Create or schedule a post.
 *
 * Validation runs through each target platform's own adapter *before* anything
 * is stored, so a caption that is too long for X or a carousel with one image is
 * rejected in the composer rather than silently failing at publish time.
 */
export async function POST(req: Request) {
  const denied = await guard("marketing.publish");
  if (denied) return denied;

  const body = (await req.json()) as {
    brandId: string;
    caption: string;
    hashtags: string[];
    mediaIds: string[];
    connectionIds: string[];
    format: PostFormat;
    scheduledAt?: string;
    perChannelCaptions?: Record<string, string>;
    firstComment?: string;
    status?: Post["status"];
  };

  const db = read();
  const connections = db.connections.filter((c) => body.connectionIds.includes(c.id));
  const errors: string[] = [];

  const targets: PostTarget[] = connections.map((c) => {
    const adapter = adapterFor(c.channel);
    const format: PostFormat =
      c.channel === "youtube" && body.format === "reel" ? "short" : c.channel === "google_business" ? "feed" : body.format;
    const caption = body.perChannelCaptions?.[c.id] ?? body.caption;

    if (adapter) {
      errors.push(
        ...adapter.validate({
          format,
          caption,
          hashtags: body.hashtags,
          mediaUrls: body.mediaIds.map((m) => `/media/${m}.mp4`),
          firstComment: body.firstComment,
        }),
      );
    }
    return {
      connectionId: c.id,
      channel: c.channel,
      format,
      caption: body.perChannelCaptions?.[c.id],
      status: (body.status ?? "scheduled") as PostTarget["status"],
      attempts: 0,
      firstComment: adapter?.capabilities.supportsFirstComment ? body.firstComment : undefined,
    };
  });

  if (errors.length) {
    return NextResponse.json({ ok: false, errors }, { status: 422 });
  }

  const now = new Date().toISOString();
  const post: Post = {
    id: uid("post"),
    brandId: body.brandId,
    status: body.status ?? "scheduled",
    caption: body.caption,
    hashtags: body.hashtags,
    mediaIds: body.mediaIds,
    targets,
    scheduledAt: body.scheduledAt,
    autoScheduled: false,
    approvals: [],
    createdBy: "You",
    createdAt: now,
    updatedAt: now,
  };

  mutate((d) => {
    d.posts.push(post);
  });
  logActivity(body.brandId, "compose", `Scheduled "${post.caption.slice(0, 40)}" to ${targets.length} channels`, "user");
  return NextResponse.json({ ok: true, post });
}

/** Move a post to a new time (calendar drag, or the reschedule action). */
export async function PATCH(req: Request) {
  const denied = await guard("marketing.publish");
  if (denied) return denied;

  const { postId, scheduledAt, status } = (await req.json()) as {
    postId: string;
    scheduledAt?: string;
    status?: Post["status"];
  };
  mutate((db) => {
    const p = db.posts.find((x) => x.id === postId);
    if (!p) return;
    if (scheduledAt) {
      p.scheduledAt = scheduledAt;
      for (const t of p.targets) t.scheduledAt = scheduledAt;
    }
    if (status) p.status = status;
    p.updatedAt = new Date().toISOString();
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const denied = await guard("marketing.publish");
  if (denied) return denied;

  const { postId } = (await req.json()) as { postId: string };
  mutate((db) => {
    db.posts = db.posts.filter((p) => p.id !== postId);
  });
  return NextResponse.json({ ok: true });
}
