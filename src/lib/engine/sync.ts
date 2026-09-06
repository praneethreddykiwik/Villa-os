import { isUsableConnection } from "../platforms/registry";
import { mutate, read } from "../db";
import { uid } from "../ids";
import { analyseReview } from "../ai/reviews";
import { graphVersion } from "../platforms/types";
import { DRIVER } from "../platforms/types";
import { isUploadPostConnection } from "../uploadpost/connections";
import { syncYouTubeStats, type YouTubeSnapshotFetcher } from "./youtube-sync";
import type { ChannelId, Connection, Conversation, Review } from "../types";

/**
 * RETRIEVAL
 *
 * Pulls everything inbound — comments, mentions, DMs, WhatsApp messages and
 * reviews — from every connected channel into the two models the UI reads:
 * `conversations` and `reviews`.
 *
 * Two properties this has to guarantee:
 *  - **Idempotence.** Every item is keyed by its platform id, so re-running the
 *    sync (a cron, a button, a webhook replay) never duplicates a message.
 *  - **Partial success.** One channel's token being dead must not abort the
 *    others, so each source is caught independently and reported per-channel.
 */

/**
 * One line per connection in the sync report.
 *
 * `status` is what the UI keys on: "synced" pulled real data, "skipped" means
 * the source cannot be read from this deployment and `detail` says why, "error"
 * means it was tried and failed. `error` is kept (and only set for errors) so
 * older readers that filter on it keep working.
 */
export type SourceStatus = "synced" | "skipped" | "error";

export interface SourceResult {
  channel: ChannelId;
  connectionId: string;
  handle: string;
  status: SourceStatus;
  fetched: number;
  created: number;
  /** Human-readable outcome — why a source was skipped, or what it synced. */
  detail?: string;
  error?: string;
  /** Present when a stats row was written (YouTube). */
  stats?: { impressions: number; engagements: number; posts: number; followers: number };
}

export interface SyncResult {
  ok: boolean;
  brandId: string;
  at: string;
  sources: SourceResult[];
  totals: { conversations: number; reviews: number; synced: number; skipped: number; errored: number };
}

/** Test seam: retrieveAll fetches YouTube through this unless told otherwise. */
export interface SyncOptions {
  youtube?: YouTubeSnapshotFetcher;
  /** Restrict the run to these channels (page-driven freshness refreshes only YouTube). */
  only?: ChannelId[];
  /** Skip the activity-feed entry — a background refresh every ten minutes would drown the feed. */
  silent?: boolean;
}

/**
 * Why an Upload-Post-backed row cannot be retrieved from, per network.
 *
 * Upload-Post holds the network tokens on its side and exposes a publish API
 * only; there is no endpoint for comments, DMs, reviews or insights. Reading
 * any of those needs the network's own OAuth grant stored on the connection.
 */
const UPLOAD_POST_SKIP: Partial<Record<ChannelId, string>> = {
  instagram: "Instagram comments, DMs and insights need the native Meta connection (OAuth) — the publishing connector publishes but does not expose them.",
  facebook: "Facebook comments, Messenger and Page insights need the native Meta connection (OAuth) — the publishing connector publishes but does not expose them.",
  linkedin: "LinkedIn comments and analytics need the native LinkedIn connection (OAuth) — the publishing connector publishes but does not expose them.",
  tiktok: "TikTok comments and video stats need the native TikTok connection (OAuth) — the publishing connector publishes but does not expose them.",
  x: "X mentions and analytics need the native X connection (OAuth) — the publishing connector publishes but does not expose them.",
  google_business: "Google reviews and Q&A need the native Google Business Profile connection (OAuth) — the publishing connector publishes but does not expose them.",
};

function skipReason(conn: Connection): string {
  return UPLOAD_POST_SKIP[conn.channel] ?? `${conn.channel} is linked through the publishing connector, which publishes but does not expose inbound data or insights.`;
}

/** Endpoints used per channel in live mode — kept next to the code that needs them. */
export const RETRIEVAL_ENDPOINTS: Record<string, string[]> = {
  instagram: [
    "GET /{ig-user-id}/media?fields=comments{id,text,username,timestamp}",
    "GET /{ig-user-id}/tags  — posts that mention you",
    "GET /{ig-user-id}/conversations?platform=instagram — DMs",
  ],
  facebook: [
    "GET /{page-id}/feed?fields=comments{id,message,from,created_time}",
    "GET /{page-id}/conversations — Messenger threads",
    "GET /{page-id}/ratings — page recommendations",
  ],
  whatsapp: ["Webhook POST /api/webhooks/whatsapp (messages arrive push, not pull)"],
  google_business: [
    "GET /v4/accounts/{acct}/locations/{loc}/reviews",
    "GET /v1/locations/{loc}:fetchMultiDailyMetricsTimeSeries",
    "GET /v4/accounts/{acct}/locations/{loc}/questions",
  ],
  tiktok: ["GET /v2/video/comment/list/"],
  youtube: ["GET /youtube/v3/commentThreads?allThreadsRelatedToChannelId={id}"],
  linkedin: ["GET /rest/socialActions/{urn}/comments"],
  x: ["GET /2/users/{id}/mentions"],
};

/* -------------------------------------------------------------------------- */
/* Live fetchers                                                              */
/* -------------------------------------------------------------------------- */

async function fetchInstagramComments(igUserId: string, token: string): Promise<Partial<Conversation>[]> {
  const url = new URL(`https://graph.facebook.com/${graphVersion()}/${igUserId}/media`);
  url.search = new URLSearchParams({
    access_token: token,
    fields: "id,permalink,comments.limit(25){id,text,username,timestamp}",
    limit: "25",
  }).toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Instagram comments ${res.status}`);
  const json = (await res.json()) as {
    data?: Array<{ id: string; comments?: { data?: Array<{ id: string; text: string; username: string; timestamp: string }> } }>;
  };
  return (json.data ?? []).flatMap((m) =>
    (m.comments?.data ?? []).map((c) => ({
      id: c.id,
      channel: "instagram" as ChannelId,
      kind: "comment" as const,
      author: `@${c.username}`,
      text: c.text,
      createdAt: c.timestamp,
      postId: m.id,
    })),
  );
}

async function fetchGoogleReviews(account: string, location: string, token: string): Promise<Partial<Review>[]> {
  const res = await fetch(`https://mybusiness.googleapis.com/v4/accounts/${account}/locations/${location}/reviews`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Google reviews ${res.status}`);
  const json = (await res.json()) as {
    reviews?: Array<{ reviewId: string; reviewer?: { displayName?: string }; starRating?: string; comment?: string; createTime?: string; reviewReply?: { comment: string } }>;
  };
  const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
  return (json.reviews ?? []).map((r) => ({
    id: r.reviewId,
    source: "google" as const,
    // Google allows a reviewer with no display name, so the absence is real and
    // gets said plainly rather than dressed up as a name we do not have.
    author: r.reviewer?.displayName ?? "Unknown reviewer",
    // No star rating (missing, or STAR_RATING_UNSPECIFIED) leaves this undefined
    // on purpose. The old `?? FIVE` turned every unrated review into a five-star
    // one, which silently pushed the brand's headline average up; the caller
    // decides what to do with a review it cannot score.
    rating: r.starRating ? STARS[r.starRating] : undefined,
    text: r.comment ?? "",
    createdAt: r.createTime ?? new Date().toISOString(),
    replied: Boolean(r.reviewReply),
    reply: r.reviewReply?.comment,
  }));
}

/* -------------------------------------------------------------------------- */
/* Orchestration                                                              */
/* -------------------------------------------------------------------------- */

export async function retrieveAll(brandId: string, opts: SyncOptions = {}): Promise<SyncResult> {
  const db = read();
  // A tokenless row cannot be retrieved from, however "connected" it claims to be.
  const connections = db.connections.filter(
    (c) => c.brandId === brandId && isUsableConnection(c) && (!opts.only || opts.only.includes(c.channel)),
  );
  const sources: SourceResult[] = [];
  const inbound: Partial<Conversation>[] = [];
  const inboundReviews: Partial<Review>[] = [];
  const base = (conn: Connection) => ({ channel: conn.channel, connectionId: conn.id, handle: conn.handle, fetched: 0, created: 0 });

  for (const conn of connections) {
    if (conn.channel === "meta_ads" || conn.channel === "google_ads") continue;

    // YouTube's numbers are public, so it gets a stats row whether the row is
    // native or Upload-Post-backed. Comments still need OAuth; say so rather
    // than pretend the inbox is quiet.
    if (conn.channel === "youtube") {
      const out = await syncYouTubeStats(conn, opts.youtube);
      sources.push(
        out.ok
          ? { ...base(conn), status: "synced", stats: out.stats, detail: `Public stats refreshed for today: ${out.stats!.posts} videos, ${out.stats!.impressions} views, ${out.stats!.followers} subscribers. Comments need the native YouTube connection (OAuth).` }
          : { ...base(conn), status: "error", error: out.error },
      );
      continue;
    }

    // Upload-Post rows have no token of their own: nothing here can be fetched.
    // This is the expected state of this deployment, so it is a skip, not an error.
    if (isUploadPostConnection(conn) || !conn.accessToken?.trim()) {
      sources.push({ ...base(conn), status: "skipped", detail: skipReason(conn) });
      continue;
    }

    try {
      let fetched: Partial<Conversation>[] = [];

      if (DRIVER === "live") {
        if (conn.channel === "instagram") {
          fetched = await fetchInstagramComments(conn.externalId, conn.accessToken);
        } else if (conn.channel === "google_business") {
          const reviews = await fetchGoogleReviews(
            process.env.GBP_ACCOUNT_ID ?? "",
            process.env.GBP_LOCATION_ID ?? conn.externalId,
            conn.accessToken,
          );
          inboundReviews.push(...reviews.map((r) => ({ ...r, brandId })));
        } else {
          // Remaining channels: see RETRIEVAL_ENDPOINTS. Each is a self-contained
          // fetcher following the same shape as the two above.
          sources.push({ ...base(conn), status: "skipped", detail: `This build has no ${conn.channel} retrieval fetcher yet (see RETRIEVAL_ENDPOINTS).` });
          continue;
        }
      } else {
        // No live credentials for this channel. Previously this fabricated a
        // handful of plausible comments and DMs so the inbox looked alive; that
        // put invented phone numbers and review text in front of operators with
        // nothing marking them as unreal. An unconfigured channel now retrieves
        // nothing and says so, which is the truth.
        sources.push({
          ...base(conn),
          status: "skipped",
          detail: `PLATFORM_DRIVER="${DRIVER}" — set PLATFORM_DRIVER=live to retrieve real messages.`,
        });
        continue;
      }

      inbound.push(...fetched);
      sources.push({ ...base(conn), status: "synced", fetched: fetched.length });
    } catch (e) {
      // One dead token must not take the whole sync down.
      sources.push({ ...base(conn), status: "error", error: (e as Error).message });
    }
  }

  // A silent run that fetched nothing and synced nothing has no rows to write
  // and no stamp to set; skip the full-file rewrite of the store.
  const nothingToWrite = opts.silent && inbound.length === 0 && inboundReviews.length === 0 && !sources.some((s) => s.status === "synced");
  const created = nothingToWrite ? { conversations: 0, reviews: 0 } : mutate((d) => {
    let convCount = 0;
    let revCount = 0;
    let skippedRev = 0;
    const seenConv = new Set(d.conversations.map((c) => c.id));
    const seenRev = new Set(d.reviews.map((r) => r.id));

    for (const item of inbound) {
      const id = item.id ?? uid("conv");
      if (seenConv.has(id)) continue; // idempotent by platform id
      seenConv.add(id);
      convCount += 1;
      d.conversations.unshift({
        id,
        brandId,
        channel: item.channel ?? "instagram",
        kind: item.kind ?? "comment",
        author: item.author ?? "Unknown",
        text: item.text ?? "",
        createdAt: item.createdAt ?? new Date().toISOString(),
        status: "open",
        sentiment: /slow|not |never|broken|bad/i.test(item.text ?? "") ? "negative" : "neutral",
        isLead: item.isLead ?? /price|cost|how much|available|availability|book/i.test(item.text ?? ""),
      });
      const source = sources.find((s) => s.channel === item.channel);
      if (source) source.created += 1;
    }

    for (const r of inboundReviews) {
      const id = r.id ?? uid("rev");
      if (seenRev.has(id)) continue;
      // A review with no star rating cannot be stored: `rating` drives the
      // average, the star distribution and the sentiment call, so any default we
      // picked would be a number the reviewer never gave. Skip it and report the
      // skip instead of quietly inventing five stars.
      if (typeof r.rating !== "number") {
        skippedRev += 1;
        continue;
      }
      seenRev.add(id);
      revCount += 1;
      const { sentiment, topics } = analyseReview(r.text ?? "", r.rating);
      d.reviews.unshift({
        id,
        brandId,
        source: r.source ?? "google",
        author: r.author ?? "Unknown reviewer",
        rating: r.rating,
        text: r.text ?? "",
        createdAt: r.createdAt ?? new Date().toISOString(),
        replied: r.replied ?? false,
        reply: r.reply,
        sentiment,
        topics,
      });
    }

    // Stamp only the sources that actually synced, so "last synced" on the
    // Connections page is a fact about that channel, not about the button.
    const syncedIds = new Set(sources.filter((s) => s.status === "synced").map((s) => s.connectionId));
    for (const c of d.connections) {
      if (syncedIds.has(c.id)) c.lastSyncedAt = new Date().toISOString();
    }

    if (!opts.silent) d.activity.unshift({
      id: uid("act"),
      brandId,
      at: new Date().toISOString(),
      actor: "system",
      kind: "sync",
      message:
        `Retrieved ${convCount} new message(s) and ${revCount} review(s) · ` +
        `${sources.filter((s) => s.status === "synced").length} synced, ` +
        `${sources.filter((s) => s.status === "skipped").length} skipped, ` +
        `${sources.filter((s) => s.status === "error").length} errored` +
        (skippedRev > 0 ? ` · ${skippedRev} review(s) skipped: no star rating returned by the platform` : ""),
    });

    return { conversations: convCount, reviews: revCount };
  });

  const count = (st: SourceStatus) => sources.filter((s) => s.status === st).length;
  return {
    ok: true,
    brandId,
    at: new Date().toISOString(),
    sources,
    totals: { ...created, synced: count("synced"), skipped: count("skipped"), errored: count("error") },
  };
}
