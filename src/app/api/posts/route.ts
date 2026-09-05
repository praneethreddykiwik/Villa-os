import { NextResponse } from "next/server";
import { mutate, read, resolveBrandId } from "@/lib/db";
import { uid } from "@/lib/ids";
import { adapterFor } from "@/lib/platforms/registry";
import { logActivity } from "@/lib/engine/publisher";
import type { Post, PostFormat, PostTarget } from "@/lib/types";
import { guard } from "@/lib/auth/guard";
import { actorLabel, getSession } from "@/lib/auth/session";

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

  // Authorship is read from the session, not sent by the client. guard() has
  // already resolved it and the lookup is memoised per request, so this is free;
  // the null branch only narrows the type and fails closed rather than filing
  // the post under a placeholder name that later reads as a real person.
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Sign in to continue." }, { status: 401 });

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

  /**
   * Resolve the brand rather than trusting the body.
   *
   * This took `body.brandId` verbatim. A caller that omitted it — the composer
   * does send one, but the API is reachable directly and n8n will be — wrote a
   * post with `brandId: undefined`, which matches no brand, so the record was
   * orphaned: invisible on the calendar, the queue and every analytics screen,
   * while the response said `ok: true`. An explicitly named brand that does not
   * exist is a mistake worth reporting; an absent one falls back the way every
   * other route in this codebase does.
   */
  const brandId = resolveBrandId(db, body.brandId ?? null);
  if (!brandId) {
    return NextResponse.json(
      { ok: false, error: "No brand is configured to file this post under." },
      { status: 409 },
    );
  }
  if (body.brandId && body.brandId !== brandId) {
    return NextResponse.json(
      { ok: false, error: `Unknown brand "${body.brandId}".` },
      { status: 404 },
    );
  }
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
    brandId,
    status: body.status ?? "scheduled",
    caption: body.caption,
    hashtags: body.hashtags,
    mediaIds: body.mediaIds,
    targets,
    scheduledAt: body.scheduledAt,
    autoScheduled: false,
    approvals: [],
    createdBy: session.fullName,
    createdAt: now,
    updatedAt: now,
  };

  mutate((d) => {
    d.posts.push(post);
  });
  logActivity(brandId, "compose", `Scheduled "${post.caption.slice(0, 40)}" to ${targets.length} channels`, actorLabel(session));
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

export async function GET(req: Request) {
  const denied = await guard("marketing.read");
  if (denied) return denied;

  const url = new URL(req.url);
  const db = read();
  const brandId = resolveBrandId(db, url.searchParams.get("brand"));
  const posts = db.posts.filter((p) => !brandId || p.brandId === brandId);

  return NextResponse.json({ ok: true, posts });
}

