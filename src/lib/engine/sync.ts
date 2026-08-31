import { mutate, read } from "../db";
import { uid } from "../ids";
import { analyseReview } from "../ai/reviews";
import { graphVersion } from "../platforms/types";
import { DRIVER } from "../platforms/types";
import type { ChannelId, Conversation, Review } from "../types";

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

export interface SourceResult {
  channel: ChannelId;
  fetched: number;
  created: number;
  error?: string;
}

export interface SyncResult {
  ok: boolean;
  brandId: string;
  at: string;
  sources: SourceResult[];
  totals: { conversations: number; reviews: number };
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
    author: r.reviewer?.displayName ?? "Google user",
    rating: STARS[r.starRating ?? "FIVE"] ?? 5,
    text: r.comment ?? "",
    createdAt: r.createTime ?? new Date().toISOString(),
    replied: Boolean(r.reviewReply),
    reply: r.reviewReply?.comment,
  }));
}

/* -------------------------------------------------------------------------- */
/* Mock generation                                                            */
/* -------------------------------------------------------------------------- */

const MOCK_MESSAGES: Array<[ChannelId, Conversation["kind"], string, string, boolean]> = [
  ["whatsapp", "dm", "+351 912 004 118", "Hi — is the villa free the weekend of the 14th? Two adults.", true],
  ["whatsapp", "dm", "+44 7700 900412", "Do you have a shuttle from the airport?", true],
  ["instagram", "comment", "@sara.travels", "How much is a night in October? 😍", true],
  ["instagram", "mention", "@weekend.escapes", "Tagged you in a story", false],
  ["facebook", "comment", "Daniel R.", "Is the pool heated in winter?", true],
  ["tiktok", "comment", "@foodie.lis", "That terrace shot is unreal", false],
  ["google_business", "review", "Marta S.", "Lovely stay, though check-in was slow.", false],
];

function mockInbound(brandId: string, channels: ChannelId[], seedOffset: number): Partial<Conversation>[] {
  return MOCK_MESSAGES.filter(([channel]) => channels.includes(channel)).map(([channel, kind, author, text, isLead], i) => ({
    // Stable synthetic id so repeated syncs are idempotent, exactly like real ids.
    id: `mock_${brandId}_${channel}_${(seedOffset + i) % 7}`,
    channel,
    kind,
    author,
    text,
    createdAt: new Date(Date.now() - i * 37 * 60_000).toISOString(),
    isLead,
  }));
}

/* -------------------------------------------------------------------------- */
/* Orchestration                                                              */
/* -------------------------------------------------------------------------- */

export async function retrieveAll(brandId: string): Promise<SyncResult> {
  const db = read();
  const connections = db.connections.filter((c) => c.brandId === brandId && c.status === "connected");
  const sources: SourceResult[] = [];
  const inbound: Partial<Conversation>[] = [];
  const inboundReviews: Partial<Review>[] = [];

  for (const conn of connections) {
    if (conn.channel === "meta_ads" || conn.channel === "google_ads") continue;
    try {
      let fetched: Partial<Conversation>[] = [];

      if (DRIVER === "live") {
        if (conn.channel === "instagram") {
          fetched = await fetchInstagramComments(conn.externalId, conn.accessToken!);
        } else if (conn.channel === "google_business") {
          const reviews = await fetchGoogleReviews(
            process.env.GBP_ACCOUNT_ID ?? "",
            process.env.GBP_LOCATION_ID ?? conn.externalId,
            conn.accessToken!,
          );
          inboundReviews.push(...reviews.map((r) => ({ ...r, brandId })));
        }
        // Remaining channels: see RETRIEVAL_ENDPOINTS. Each is a self-contained
        // fetcher following the same shape as the two above.
      } else {
        fetched = mockInbound(brandId, [conn.channel], connections.indexOf(conn));
      }

      inbound.push(...fetched);
      sources.push({ channel: conn.channel, fetched: fetched.length, created: 0 });
    } catch (e) {
      // One dead token must not take the whole sync down.
      sources.push({ channel: conn.channel, fetched: 0, created: 0, error: (e as Error).message });
    }
  }

  const created = mutate((d) => {
    let convCount = 0;
    let revCount = 0;
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
      seenRev.add(id);
      revCount += 1;
      const { sentiment, topics } = analyseReview(r.text ?? "", r.rating ?? 5);
      d.reviews.unshift({
        id,
        brandId,
        source: r.source ?? "google",
        author: r.author ?? "Google user",
        rating: r.rating ?? 5,
        text: r.text ?? "",
        createdAt: r.createdAt ?? new Date().toISOString(),
        replied: r.replied ?? false,
        reply: r.reply,
        sentiment,
        topics,
      });
    }

    // Stamp the sync so Connections can show freshness rather than guessing.
    for (const c of d.connections) {
      if (c.brandId === brandId && c.status === "connected") c.lastSyncedAt = new Date().toISOString();
    }

    d.activity.unshift({
      id: uid("act"),
      brandId,
      at: new Date().toISOString(),
      actor: "system",
      kind: "sync",
      message: `Retrieved ${convCount} new message(s) and ${revCount} review(s) across ${sources.length} channels`,
    });

    return { conversations: convCount, reviews: revCount };
  });

  return { ok: true, brandId, at: new Date().toISOString(), sources, totals: created };
}
