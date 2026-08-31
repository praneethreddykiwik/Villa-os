import { addDays, id, isoDay, makeRng } from "./ids";
import { analyseReview } from "./ai/reviews";
import { DEFAULT_EDIT } from "./media/render";
import { makeBoard } from "./board/templates";
import { buildCrm } from "./crm/seed";
import type {
  Ad,
  Board,
  BoardCard,
  BoardColumn,
  AdCampaign,
  AdSet,
  AdStat,
  Brand,
  ChannelId,
  Competitor,
  Connection,
  Conversation,
  DailyStat,
  Database,
  Idea,
  MediaAsset,
  Post,
  PostFormat,
  PostTarget,
  RankGridCell,
  Review,
  Workspace,
} from "./types";

/**
 * SEED DATA
 *
 * Deterministic (seeded PRNG) so the dashboard looks identical on every machine.
 *
 * Deliberately *engineered*, not random: the data contains a fatigued ad, a
 * ROAS imbalance between two ad sets, one viral organic post, a genuinely better
 * posting slot, a cluster of weak video hooks, unanswered negative reviews and a
 * patchy local rank grid — so every analyser in ai/signals.ts has something real
 * to find on first load. Random noise alone would produce an empty insights page.
 */

const rng = makeRng(20260831);
const TODAY = new Date("2026-08-31T09:00:00Z");
// Long enough that the 90-day view still has a full 90-day comparison window
// behind it — otherwise period-over-period deltas read as huge growth that is
// really just the edge of the dataset.
const HISTORY_DAYS = 200;

/* -------------------------------------------------------------------------- */
/* Brands                                                                      */
/* -------------------------------------------------------------------------- */

const BRAND_BLUEPRINTS = [
  {
    name: "Aurum Residences",
    industry: "Luxury real estate",
    voice:
      "Precise and unhurried. We talk about light, ceiling heights and the drive home — never about 'luxury lifestyle'. Numbers are stated plainly, including the ones buyers dislike.",
    audience: "HNWI and NRI buyers aged 35–60 purchasing a primary or second home between ₹1.2 Cr and ₹25 Cr",
    offerings: ["Sky residences — Worli", "Garden apartments — Bandra", "Sea-face villas — Alibaug", "Signature homes — Lower Parel"],
    color: "#b08d57",
    website: "aurumresidences.example",
    timezone: "Asia/Kolkata",
  },
  {
    name: "Villa Serena",
    industry: "Boutique hospitality",
    voice:
      "Calm, sensory and understated. We describe the place, not ourselves. Never shout, never use exclamation marks, never say 'luxury' — show it.",
    audience: "Couples aged 28–45 booking a 2–4 night escape within 3 hours of home",
    offerings: ["Suites & villas", "Private pool cabanas", "Sunset dining", "Spa & treatments", "Weddings & events"],
    color: "#0EA5A4",
    website: "villaserena.example",
    timezone: "Europe/Lisbon",
  },
  {
    name: "Goodfellas Pizza",
    industry: "Restaurant",
    voice: "Loud, funny, local. Short sentences. We talk about the dough like other people talk about their kids.",
    audience: "Families and students within a 3km delivery radius",
    offerings: ["Neapolitan pizza", "Late-night delivery", "Group deals"],
    color: "#F97316",
    website: "goodfellas.example",
    timezone: "America/New_York",
  },
  {
    name: "Bloom & Stem",
    industry: "Florist",
    voice: "Warm, seasonal, craft-led. We name the flowers. We never use stock language.",
    audience: "Gift buyers and weekly-subscription locals aged 30–60",
    offerings: ["Weekly subscriptions", "Wedding florals", "Same-day delivery"],
    color: "#EC4899",
    website: "bloomandstem.example",
    timezone: "Europe/London",
  },
];

const CHANNELS_PER_BRAND: Record<string, ChannelId[]> = {
  "Aurum Residences": ["instagram", "facebook", "youtube", "linkedin", "google_business"],
  "Villa Serena": ["instagram", "facebook", "tiktok", "youtube", "google_business", "linkedin"],
  "Goodfellas Pizza": ["instagram", "facebook", "tiktok", "google_business"],
  "Bloom & Stem": ["instagram", "facebook", "google_business", "x"],
};

const HANDLES: Record<string, (b: string) => string> = {
  instagram: (b) => `@${slug(b)}`,
  facebook: (b) => `${b}`,
  tiktok: (b) => `@${slug(b)}`,
  youtube: (b) => `${b} Official`,
  linkedin: (b) => `${b} Group`,
  x: (b) => `@${slug(b)}`,
  google_business: (b) => `${b} — Google Business`,
};

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/* -------------------------------------------------------------------------- */
/* Content themes                                                              */
/* -------------------------------------------------------------------------- */

const TOPICS: Record<string, string[]> = {
  "Luxury real estate": [
    "The 3.4m ceiling, and why it costs what it costs",
    "Walkthrough — 4BHK sky residence, 34th floor",
    "What the Worli sea-face actually looks like at 6am",
    "Construction update — Tower B, month 19",
    "Carpet vs built-up, explained honestly",
    "Why we moved the lift core",
    "Stamp duty and registration, start to finish",
    "The Alibaug drive, filmed in one take",
    "Meet the structural engineer",
    "Possession timelines we will commit to in writing",
  ],
  "Boutique hospitality": [
    "Sunrise from the east suite",
    "What 6am looks like from the pool",
    "The 40-second villa tour",
    "Why we changed every mattress",
    "Our chef's Tuesday market run",
    "Three quiet corners guests always find",
    "Behind the spa treatment menu",
    "How we set the terrace for two",
    "The drive in — worth doing slowly",
    "Winter rates, honestly explained",
    "One night, start to finish",
    "The room we almost didn't build",
  ],
  Restaurant: [
    "72-hour dough, sped up",
    "The oven hits 480°C",
    "Behind the pass on a Friday",
    "Why we only do six toppings",
    "New: the Nduja",
    "Delivery in under 20",
  ],
  Florist: [
    "This week's market haul",
    "How to make tulips last",
    "A wedding arch, start to finish",
    "Seasonal: dahlias are back",
    "Subscription unboxing",
  ],
};

const FORMATS: PostFormat[] = ["reel", "feed", "story", "carousel"];

/* -------------------------------------------------------------------------- */
/* Builder                                                                     */
/* -------------------------------------------------------------------------- */

export function buildSeed(): Database {
  const workspace: Workspace = {
    id: id("ws"),
    name: "Orbit Agency",
    createdAt: addDays(TODAY, -400).toISOString(),
  };

  const db: Database = {
    workspaces: [workspace],
    brands: [],
    connections: [],
    media: [],
    posts: [],
    dailyStats: [],
    adCampaigns: [],
    adStats: [],
    reviews: [],
    rankGrid: [],
    competitors: [],
    suggestions: [],
    campaigns: [],
    conversations: [],
    ideas: [],
    reports: [],
    activity: [],
    boards: [],
    boardCards: [],
    leads: [],
    brokers: [],
    crmContacts: [],
    crmTasks: [],
  };

  for (const bp of BRAND_BLUEPRINTS) {
    const brand: Brand = {
      id: id("brand"),
      workspaceId: workspace.id,
      name: bp.name,
      voice: bp.voice,
      industry: bp.industry,
      timezone: bp.timezone,
      website: bp.website,
      color: bp.color,
      offerings: bp.offerings,
      audience: bp.audience,
      createdAt: addDays(TODAY, -365).toISOString(),
    };
    db.brands.push(brand);

    const connections = buildConnections(brand, CHANNELS_PER_BRAND[bp.name]);
    db.connections.push(...connections);
    db.media.push(...buildMedia(brand));
    const posts = buildPosts(brand, connections, db.media.filter((m) => m.brandId === brand.id));
    db.posts.push(...posts);
    db.dailyStats.push(...buildDailyStats(brand, connections, posts));

    const { campaigns, stats } = buildAds(brand, connections, posts);
    db.adCampaigns.push(...campaigns);
    db.adStats.push(...stats);

    db.reviews.push(...buildReviews(brand));
    db.rankGrid.push(...buildRankGrid(brand));
    db.competitors.push(...buildCompetitors(brand));
    db.conversations.push(...buildConversations(brand, posts));
    db.ideas.push(...buildIdeas(brand));
    db.activity.push(...buildActivity(brand));
  }

  for (const brand of db.brands) {
    if (brand.industry === "Luxury real estate") {
      const crm = buildCrm(brand.id, TODAY);
      db.brokers.push(...crm.brokers);
      db.leads.push(...crm.leads);
      db.crmContacts.push(...crm.contacts);
      db.crmTasks.push(...crm.tasks);
    }
    const { board, cards } = buildBoard(brand, db.posts.filter((p) => p.brandId === brand.id));
    db.boards.push(board);
    db.boardCards.push(...cards);
  }

  db.reports.push(buildReport(db.brands[0].id));
  return db;
}

/* -------------------------------------------------------------------------- */

function buildConnections(brand: Brand, channels: ChannelId[]): Connection[] {
  const base: Record<string, number> = {
    "Aurum Residences": 68400,
    "Villa Serena": 41200,
    "Goodfellas Pizza": 8600,
    "Bloom & Stem": 15400,
  };
  const share: Partial<Record<ChannelId, number>> = {
    instagram: 1,
    facebook: 0.55,
    tiktok: 0.42,
    youtube: 0.18,
    linkedin: 0.09,
    x: 0.12,
    google_business: 0.0,
  };

  const conns = channels.map((channel, i) => ({
    id: id("conn"),
    brandId: brand.id,
    channel,
    handle: HANDLES[channel](brand.name),
    externalId: `${channel}_${slug(brand.name)}_${1000 + i}`,
    // One expired token on purpose: the connections page must have something to fix.
    status: (brand.name === "Villa Serena" && channel === "tiktok" ? "expired" : "connected") as Connection["status"],
    accessToken: "seed-token-not-real",
    tokenExpiresAt: addDays(TODAY, channel === "tiktok" ? -2 : 45).toISOString(),
    scopes:
      channel === "instagram"
        ? ["instagram_basic", "instagram_content_publish", "instagram_manage_insights", "instagram_manage_comments"]
        : channel === "facebook"
          ? ["pages_manage_posts", "pages_read_engagement", "read_insights"]
          : ["read", "publish"],
    avatarColor: brand.color,
    followers: Math.round((base[brand.name] ?? 10000) * (share[channel] ?? 0.2)),
    connectedAt: addDays(TODAY, -300).toISOString(),
    lastSyncedAt: addDays(TODAY, 0).toISOString(),
    lastError: brand.name === "Villa Serena" && channel === "tiktok" ? "Access token expired — reconnect required" : undefined,
  }));

  // WhatsApp Business: no followers, no feed — a conversation channel that
  // nonetheless belongs in Connections and the inbox.
  conns.push({
    id: id("conn"),
    brandId: brand.id,
    channel: "whatsapp",
    handle: "+351 912 000 100",
    externalId: `wa_${slug(brand.name).slice(0, 8)}`,
    status: "connected",
    accessToken: "seed-token-not-real",
    tokenExpiresAt: addDays(TODAY, 90).toISOString(),
    scopes: ["whatsapp_business_messaging", "whatsapp_business_management"],
    avatarColor: "#25D366",
    followers: 0,
    connectedAt: addDays(TODAY, -120).toISOString(),
    lastSyncedAt: TODAY.toISOString(),
    lastError: undefined,
  });

  // Ad accounts hang off the same brand.
  conns.push({
    id: id("conn"),
    brandId: brand.id,
    channel: "meta_ads",
    handle: `act_${slug(brand.name).slice(0, 8)}`,
    externalId: `act_${100000 + conns.length}`,
    status: "connected",
    accessToken: "seed-token-not-real",
    tokenExpiresAt: addDays(TODAY, 60).toISOString(),
    scopes: ["ads_read", "ads_management"],
    avatarColor: "#0866FF",
    followers: 0,
    connectedAt: addDays(TODAY, -300).toISOString(),
    lastSyncedAt: TODAY.toISOString(),
    lastError: undefined,
  });
  conns.push({
    id: id("conn"),
    brandId: brand.id,
    channel: "google_ads",
    handle: `${slug(brand.name).slice(0, 6)}-ads`,
    externalId: `${300 + conns.length}-555-0${conns.length}`,
    status: "connected",
    accessToken: "seed-token-not-real",
    tokenExpiresAt: addDays(TODAY, 60).toISOString(),
    scopes: ["adwords"],
    avatarColor: "#FBBC04",
    followers: 0,
    connectedAt: addDays(TODAY, -280).toISOString(),
    lastSyncedAt: TODAY.toISOString(),
    lastError: undefined,
  });
  return conns;
}

function buildMedia(brand: Brand): MediaAsset[] {
  const topics = TOPICS[brand.industry] ?? TOPICS["Restaurant"];
  return topics.slice(0, 10).map((t, i) => ({
    id: id("media"),
    brandId: brand.id,
    kind: (i % 3 === 2 ? "image" : "video") as MediaAsset["kind"],
    src: `/samples/${slug(brand.name)}-${i + 1}.mp4`,
    posterSrc: `/samples/${slug(brand.name)}-${i + 1}.jpg`,
    width: 1080,
    height: 1920,
    durationSec: rng.int(9, 42),
    edit: { ...DEFAULT_EDIT, trimEndSec: rng.int(8, 20) },
    renders: {},
    createdAt: addDays(TODAY, -rng.int(1, 90)).toISOString(),
    tags: [t.split(" ")[0].toLowerCase(), brand.industry.split(" ")[0].toLowerCase()],
  }));
}

/**
 * Posts across 120 days.
 *
 * Engineered patterns:
 *  - Thursday 18:00 and Saturday 10:00 genuinely outperform (posting-time signal).
 *  - Reels out-reach feed posts ~2.2x (format-mix signal).
 *  - A third of reels have a weak 3s hook (hook-quality signal).
 *  - One recent post is a 3σ engagement outlier (boost-organic signal).
 *  - One scheduled post has a permanent failure (queue-health signal).
 */
function buildPosts(brand: Brand, connections: Connection[], media: MediaAsset[]): Post[] {
  const social = connections.filter((c) => !NON_PUBLISHING.includes(c.channel));
  const topics = TOPICS[brand.industry] ?? TOPICS["Restaurant"];
  const posts: Post[] = [];
  const totalFollowers = social.reduce((a, c) => a + c.followers, 0) || 10000;

  for (let day = HISTORY_DAYS; day >= -10; day--) {
    const date = addDays(TODAY, -day);
    const dow = date.getDay();
    // Cadence: ~4-5 posts/week, more on Thu/Sat.
    const chance = dow === 4 || dow === 6 ? 0.85 : dow === 0 ? 0.2 : 0.5;
    if (!rng.bool(chance)) continue;

    const hour = dow === 4 ? 18 : dow === 6 ? 10 : rng.pick([8, 11, 13, 17, 19, 20]);
    date.setHours(hour, rng.int(0, 55), 0, 0);
    const future = date.getTime() > TODAY.getTime();

    const format = rng.pick(FORMATS);
    const topic = rng.pick(topics);
    const asset = rng.pick(media);
    const chosen = social.filter((c) => {
      if (format === "story") return c.channel === "instagram" || c.channel === "facebook";
      if (format === "reel") return ["instagram", "facebook", "tiktok", "youtube"].includes(c.channel);
      if (format === "carousel") return ["instagram", "linkedin", "facebook"].includes(c.channel);
      return true;
    });
    if (!chosen.length) continue;

    const targets: PostTarget[] = chosen.map((c) => ({
      connectionId: c.id,
      channel: c.channel,
      format:
        c.channel === "youtube" && format === "reel"
          ? "short"
          : c.channel === "google_business"
            ? "feed"
            : format,
      status: future ? "scheduled" : "published",
      externalId: future ? undefined : `${c.channel}_${id("ext")}`,
      permalink: future ? undefined : `https://example.invalid/${c.channel}/p/${rng.int(100000, 999999)}`,
      attempts: future ? 0 : 1,
      stickers:
        format === "story" && rng.bool(0.4)
          ? [{ type: "poll", value: "Which room?", options: ["Garden", "Sea view"] }]
          : undefined,
      firstComment: c.channel === "instagram" ? "#" + slug(brand.name) + " #" + slug(brand.industry) : undefined,
    }));

    // Format multipliers reflect real distribution differences.
    const formatReach = format === "reel" ? 2.2 : format === "story" ? 0.35 : format === "carousel" ? 1.25 : 1;
    const slotBoost = (dow === 4 && hour === 18) || (dow === 6 && hour === 10) ? 1.45 : 1;
    const recency = 1 + (HISTORY_DAYS - day) / (HISTORY_DAYS * 2.5); // account growing over time

    // Reach is driven by the follower base of the channels this post actually
    // goes to — not the account total. Using the total and then crediting it to
    // every channel is what makes seeded dashboards show 100x spikes on post days.
    const audience = chosen.reduce((a, c) => a + audienceOf(c, totalFollowers), 0);
    // ~12% of the audience for a plain post; a reel roughly doubles that via
    // non-follower distribution. Anything near 100% per post is not realistic.
    const baseReach = audience * 0.12 * formatReach * slotBoost * recency * rng.float(0.7, 1.35);
    const reach = Math.round(baseReach);
    const impressions = Math.round(reach * rng.float(1.15, 1.6));
    const erBase = 0.035 * slotBoost * (format === "reel" ? 1.15 : 1) * rng.float(0.6, 1.4);
    const engagements = Math.round(impressions * erBase);

    // A third of reels get a weak hook on purpose.
    const weakHook = format === "reel" && rng.bool(0.34);
    const retention3s = weakHook ? rng.float(0.28, 0.44) : rng.float(0.55, 0.82);

    const likes = Math.round(engagements * 0.72);
    const comments = Math.round(engagements * 0.11);
    const shares = Math.round(engagements * 0.09);
    const saves = engagements - likes - comments - shares;

    const post: Post = {
      id: id("post"),
      brandId: brand.id,
      status: future ? (rng.bool(0.75) ? "scheduled" : "needs_approval") : "published",
      caption: `${topic}. ${brand.offerings[0]} — ${brand.name}.`,
      hashtags: [slug(brand.industry), slug(brand.name), slug(topic).slice(0, 14)],
      mediaIds: [asset.id],
      targets,
      scheduledAt: date.toISOString(),
      publishedAt: future ? undefined : date.toISOString(),
      autoScheduled: rng.bool(0.35),
      approvals: future && rng.bool(0.4) ? [{ by: "Ana", at: date.toISOString(), decision: "approved" }] : [],
      createdBy: rng.pick(["Ana", "Marco", "AI Agent"]),
      createdAt: addDays(date, -2).toISOString(),
      updatedAt: date.toISOString(),
      aiNotes: weakHook ? ["Hook holds under 45% at 3s — rewrite the opening line."] : undefined,
      metrics: future
        ? undefined
        : {
            impressions,
            reach,
            likes,
            comments,
            shares,
            saves,
            videoViews: format === "reel" || format === "story" ? Math.round(reach * rng.float(0.8, 1.1)) : 0,
            completionRate: weakHook ? rng.float(0.12, 0.28) : rng.float(0.35, 0.62),
            retention3s,
            profileVisits: Math.round(reach * rng.float(0.01, 0.035)),
            linkClicks: Math.round(reach * rng.float(0.004, 0.018)),
            followsFromPost: Math.round(reach * rng.float(0.001, 0.006)),
            engagementRate: (engagements / impressions) * 100,
            updatedAt: TODAY.toISOString(),
          },
    };
    posts.push(post);
  }

  // --- Engineered outlier: one recent viral post to trigger boost-organic ---
  const recent = posts.filter((p) => p.metrics && p.publishedAt && new Date(p.publishedAt) > addDays(TODAY, -6));
  if (recent.length) {
    const star = recent[Math.floor(recent.length / 2)];
    star.caption = `${TOPICS[brand.industry]?.[0] ?? "Behind the scenes"} — the version we almost deleted`;
    star.metrics!.reach = Math.round(star.metrics!.reach * 4.1);
    star.metrics!.impressions = Math.round(star.metrics!.impressions * 4.3);
    star.metrics!.engagementRate = 11.4;
    star.metrics!.retention3s = 0.79;
    star.metrics!.saves = Math.round(star.metrics!.saves * 5);
    star.metrics!.followsFromPost = Math.round(star.metrics!.followsFromPost * 6);
  }

  // --- Engineered failure: a scheduled post that hit a permanent error ---
  const upcoming = posts.filter((p) => p.status === "scheduled");
  if (upcoming.length) {
    const broken = upcoming[0];
    broken.status = "failed";
    broken.targets[0].status = "failed";
    broken.targets[0].attempts = 4;
    broken.targets[0].error = "Instagram: media container error — video is 1080x1350, reels require 9:16";
  }

  // --- Two posts that are due right now -------------------------------------
  // Realistic state after the worker has been down for an hour, and it makes
  // "Run queue now" in the calendar actually do something on a fresh install.
  // Anchored to wall-clock time rather than the seed date, because "due" is by
  // definition relative to when you press the button.
  const dueNow = posts.filter((p) => p.status === "scheduled").slice(0, 2);
  dueNow.forEach((p, i) => {
    const when = new Date(Date.now() - (25 - i * 10) * 60_000).toISOString();
    p.scheduledAt = when;
    for (const t of p.targets) {
      t.scheduledAt = when;
      t.status = "scheduled";
      t.externalId = undefined;
      t.permalink = undefined;
      t.attempts = 0;
    }
  });

  return posts;
}

/**
 * Channels that have no feed, so they generate no reach, impressions or posts.
 * Ad accounts are billing entities; WhatsApp is a conversation channel. Including
 * either in the reach charts invents numbers that do not exist.
 */
const NON_PUBLISHING = ["meta_ads", "google_ads", "whatsapp"];

/**
 * A channel's effective audience. Google Business has no followers — its reach is
 * search-driven — so it gets a proxy audience rather than being modelled as zero
 * and silently disappearing from every chart.
 */
function audienceOf(conn: Connection, totalFollowers: number): number {
  return conn.followers > 0 ? conn.followers : Math.round(totalFollowers * 0.3);
}

function buildDailyStats(brand: Brand, connections: Connection[], posts: Post[]): DailyStat[] {
  const social = connections.filter((c) => !NON_PUBLISHING.includes(c.channel));
  const totalFollowers = social.reduce((a, c) => a + c.followers, 0) || 10000;
  const out: DailyStat[] = [];

  for (const conn of social) {
    let followers = Math.round(conn.followers * 0.82); // grow into today's number
    for (let day = HISTORY_DAYS; day >= 0; day--) {
      const date = addDays(TODAY, -day);
      const dateStr = isoDay(date);
      const dayPosts = posts.filter(
        (p) => p.publishedAt?.slice(0, 10) === dateStr && p.targets.some((t) => t.connectionId === conn.id),
      );

      // Split each post's metrics across its targets by audience share, which is
      // the same basis the post's reach was generated from — so the daily rows
      // sum back to the post totals instead of multiplying them.
      let postImpressions = 0;
      let postReach = 0;
      let postEng = 0;
      for (const p of dayPosts) {
        const targetAudience = p.targets.reduce((a, t) => {
          const c = social.find((x) => x.id === t.connectionId);
          return a + (c ? audienceOf(c, totalFollowers) : 0);
        }, 0);
        const share = targetAudience ? audienceOf(conn, totalFollowers) / targetAudience : 0;
        postImpressions += (p.metrics?.impressions ?? 0) * share;
        postReach += (p.metrics?.reach ?? 0) * share;
        postEng +=
          ((p.metrics?.likes ?? 0) + (p.metrics?.comments ?? 0) + (p.metrics?.shares ?? 0) + (p.metrics?.saves ?? 0)) * share;
      }

      // Baseline non-post activity: profile visits, evergreen reach, search.
      const baseline = audienceOf(conn, totalFollowers) * rng.float(0.1, 0.18);
      const impressions = Math.round(postImpressions + baseline);
      const reach = Math.round(postReach + baseline * 0.7);
      const engagements = Math.round(postEng + baseline * 0.03);

      // Growth: proportional to reach, with a slow drift up.
      const delta = Math.round(reach * rng.float(0.0008, 0.0032) + rng.normal(0, 3));
      followers += Math.max(-20, delta);

      out.push({
        brandId: brand.id,
        connectionId: conn.id,
        channel: conn.channel,
        date: dateStr,
        followers,
        followerDelta: delta,
        impressions,
        reach,
        engagements,
        profileVisits: Math.round(reach * rng.float(0.01, 0.03)),
        linkClicks: Math.round(reach * rng.float(0.003, 0.012)),
        posts: dayPosts.length,
        storyViews: conn.channel === "instagram" ? Math.round(conn.followers * rng.float(0.06, 0.14)) : 0,
        videoViews: Math.round(dayPosts.reduce((a, p) => a + (p.metrics?.videoViews ?? 0), 0) * (dayPosts.length ? 1 / Math.max(1, dayPosts[0].targets.length) : 0)),
      });
    }
  }
  // Engineered anomaly: yesterday's link clicks collapse across every channel,
  // the way they do when a bio link 404s or a pixel breaks. The robust-z detector
  // must catch this on the dashboard.
  const yesterday = isoDay(addDays(TODAY, -1));
  for (const row of out) {
    if (row.date === yesterday) row.linkClicks = Math.round(row.linkClicks * 0.12);
  }

  return out;
}

/**
 * Ads.
 *
 * Engineered patterns:
 *  - "Evergreen — Suite Tour" is fatigued: frequency climbs past 4, CTR decays.
 *  - "Broad 25-45" vs "Lookalike 1%": a ~2.6x ROAS gap (budget-shift signal).
 *  - The Meta conversions campaign is pacing to overspend (pacing signal).
 */
function buildAds(brand: Brand, connections: Connection[], posts: Post[]): { campaigns: AdCampaign[]; stats: AdStat[] } {
  const metaConn = connections.find((c) => c.channel === "meta_ads")!;
  const googleConn = connections.find((c) => c.channel === "google_ads")!;
  const stats: AdStat[] = [];
  const campaigns: AdCampaign[] = [];

  const blueprint = [
    {
      conn: metaConn,
      platform: "meta_ads" as const,
      name: `${brand.name} — Conversions`,
      objective: "OUTCOME_SALES",
      dailyBudget: 120,
      sets: [
        { name: "Lookalike 1% — purchasers", audience: "LAL 1% purchasers", roas: 4.3, ctr: 1.9, share: 0.42 },
        { name: "Broad 25–45", audience: "Broad, age 25–45", roas: 1.6, ctr: 1.1, share: 0.38 },
        { name: "Retargeting 30d", audience: "Site visitors 30d", roas: 6.1, ctr: 2.7, share: 0.2 },
      ],
    },
    {
      conn: metaConn,
      platform: "meta_ads" as const,
      name: `${brand.name} — Awareness`,
      objective: "OUTCOME_AWARENESS",
      dailyBudget: 45,
      sets: [
        { name: "Local radius 25km", audience: "25km radius", roas: 0.9, ctr: 0.8, share: 0.6 },
        { name: "Interest — travel", audience: "Interest stack", roas: 1.2, ctr: 1.0, share: 0.4 },
      ],
    },
    {
      conn: googleConn,
      platform: "google_ads" as const,
      name: `${brand.name} — Search Brand + Generic`,
      objective: "SEARCH",
      dailyBudget: 80,
      sets: [
        { name: "Brand exact", audience: "Brand terms", roas: 9.2, ctr: 12.4, share: 0.3 },
        { name: "Generic — category", audience: "Non-brand", roas: 1.9, ctr: 3.1, share: 0.5 },
        { name: "Competitor terms", audience: "Competitor brands", roas: 0.7, ctr: 2.2, share: 0.2 },
      ],
    },
  ];

  for (const bp of blueprint) {
    const campaignId = id("camp");
    const adSets: AdSet[] = bp.sets.map((s) => {
      const setId = id("adset");
      const boostSource = posts.find((p) => p.status === "published" && (p.metrics?.engagementRate ?? 0) > 6);
      const ads: Ad[] = [
        {
          id: id("ad"),
          adSetId: setId,
          name: `${s.name} — Evergreen Suite Tour`,
          creativeThumb: brand.color,
          format: "reel",
          status: "active",
          sourcePostId: boostSource?.id,
        },
        {
          id: id("ad"),
          adSetId: setId,
          name: `${s.name} — Static offer`,
          creativeThumb: brand.color,
          format: "feed",
          status: "active",
        },
      ];
      return { id: setId, campaignId, name: s.name, audience: s.audience, placements: bp.platform === "meta_ads" ? ["feed", "reels", "stories"] : ["search", "display"], ads };
    });

    const days = 190;
    let lifetime = 0;

    for (let d = days; d >= 0; d--) {
      const date = isoDay(addDays(TODAY, -d));
      const age = days - d; // 0 = oldest

      bp.sets.forEach((s, si) => {
        const set = adSets[si];
        set.ads.forEach((ad, ai) => {
          const isFatigued = ai === 0 && si === 0 && bp.platform === "meta_ads";
          // Fatigue: CTR decays ~2.5%/day and frequency climbs.
          // Exponential CTR decay, no floor: a floor makes the curve flat inside the
          // reporting window and the fatigue detector then sees no trend at all.
          const fatigueAge = Math.max(0, age - (days - 45));
          const decay = isFatigued ? Math.pow(0.972, fatigueAge) : 1;
          const freq = isFatigued ? Math.min(5.4, 1.2 + fatigueAge * 0.09) : rng.float(1.1, 2.4);

          const spend = (bp.dailyBudget * s.share) / set.ads.length * rng.float(0.85, 1.15);
          const cpm = (bp.platform === "google_ads" ? 9 : 11) * (isFatigued ? 1 + age * 0.012 : 1) * rng.float(0.9, 1.1);
          const impressions = Math.round((spend / cpm) * 1000);
          const ctr = (s.ctr / 100) * decay * rng.float(0.85, 1.15);
          const clicks = Math.round(impressions * ctr);
          // Revenue is derived from spend x the ad set's target ROAS (with noise),
          // and conversions fall out of revenue / AOV. Deriving it the other way
          // round lets small errors compound into absurd ROAS figures.
          const aov = brand.industry === "Boutique hospitality" ? 420 : brand.industry === "Restaurant" ? 34 : 68;
          const conversionValue = spend * s.roas * rng.float(0.82, 1.22) * decay;
          const conversions = conversionValue / aov;

          lifetime += spend;
          stats.push({
            brandId: brand.id,
            platform: bp.platform,
            campaignId,
            adSetId: set.id,
            adId: ad.id,
            date,
            impressions,
            clicks,
            spend: Number(spend.toFixed(2)),
            conversions: Number(conversions.toFixed(2)),
            conversionValue: Number(conversionValue.toFixed(2)),
            frequency: Number(freq.toFixed(2)),
            reach: Math.round(impressions / Math.max(1, freq)),
            videoPlays: Math.round(impressions * rng.float(0.2, 0.4)),
            thruPlays: Math.round(impressions * rng.float(0.05, 0.15)),
          });
        });
      });
    }

    campaigns.push({
      id: campaignId,
      brandId: brand.id,
      connectionId: bp.conn.id,
      platform: bp.platform,
      name: bp.name,
      objective: bp.objective,
      status: "active",
      // Under-stated daily budget so the pacing analyser detects an overspend.
      dailyBudget: bp.objective === "OUTCOME_SALES" ? Math.round(bp.dailyBudget * 0.72) : bp.dailyBudget,
      lifetimeSpend: Number(lifetime.toFixed(2)),
      startDate: isoDay(addDays(TODAY, -days)),
      endDate: isoDay(addDays(TODAY, 25)),
      adSets,
    });
  }
  return { campaigns, stats };
}

const REVIEW_TEXTS: Array<[number, string, string]> = [
  [5, "Brad S.", "Fantastic place! Incredible variety and super helpful staff. The owner was particularly attentive."],
  [5, "Mark J.", "The best selection in the neighbourhood. The staff is super helpful as well."],
  [5, "Priya N.", "The view from the terrace at sunset is worth the trip on its own. Breakfast was excellent."],
  [4, "Tom H.", "Lovely stay overall. Check-in took a while but the room was spotless."],
  [4, "Elena R.", "Beautiful location and very friendly team. Wifi was patchy in the far room."],
  [2, "Chris W.", "Check-in was slow and nobody told us the pool was closed for cleaning. Disappointed for the price."],
  [3, "Sam K.", "Good food, but the wait was long on a Saturday and it got very noisy."],
  [1, "Dana P.", "Room was not clean on arrival and the aircon was broken. Staff were apologetic but nothing was fixed."],
  [5, "Luis M.", "Third year running. The spa treatments are genuinely excellent and the team remembers you."],
  [4, "Nina F.", "Great value for what you get. Parking is tight."],
  [5, "Owen B.", "Booking was easy and the sunset dinner was the highlight of our trip."],
  [3, "Rachel T.", "Nice enough, but expensive for what it is and breakfast finished early."],
];

function buildReviews(brand: Brand): Review[] {
  return REVIEW_TEXTS.map(([rating, author, text], i) => {
    const { sentiment, topics } = analyseReview(text, rating);
    // Older positives are answered; recent + negative ones are not, on purpose.
    const daysAgo = i * 6 + rng.int(0, 4);
    const replied = rating >= 4 && daysAgo > 20;
    return {
      id: id("rev"),
      brandId: brand.id,
      source: rng.pick(["google", "google", "facebook", "tripadvisor"]) as Review["source"],
      author,
      rating,
      text,
      createdAt: addDays(TODAY, -daysAgo).toISOString(),
      replied,
      reply: replied ? `Thank you, ${author.split(" ")[0]} — we really appreciate you taking the time.` : undefined,
      repliedAt: replied ? addDays(TODAY, -daysAgo + 1).toISOString() : undefined,
      sentiment,
      topics,
    };
  });
}

/** 5x5 grid, strong at the centre and falling off at the edges — like real local rank. */
function buildRankGrid(brand: Brand): RankGridCell[] {
  const keywords =
    brand.industry === "Boutique hospitality"
      ? ["boutique hotel near me", "villa with pool"]
      : brand.industry === "Luxury real estate"
        ? ["luxury apartments worli", "sea facing 4bhk mumbai"]
      : brand.industry === "Restaurant"
        ? ["pizza near me", "late night delivery"]
        : ["florist near me", "wedding flowers"];

  const cells: RankGridCell[] = [];
  for (const keyword of keywords) {
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        const dist = Math.hypot(row - 2, col - 2);
        const strength = keyword.includes("near me") ? 1 : 1.6;
        const rank = Math.max(1, Math.min(20, Math.round(1 + dist * 3.1 * strength + rng.normal(0, 1.6))));
        cells.push({
          brandId: brand.id,
          keyword,
          row,
          col,
          lat: 38.72 + (row - 2) * 0.012,
          lng: -9.14 + (col - 2) * 0.012,
          rank,
          capturedAt: addDays(TODAY, -1).toISOString(),
        });
      }
    }
  }
  return cells;
}

function buildCompetitors(brand: Brand): Competitor[] {
  const names =
    brand.industry === "Boutique hospitality"
      ? ["Casa Azul", "The Headland", "Quinta Verde"]
      : brand.industry === "Luxury real estate"
        ? ["Rustomjee Crown", "Oberoi Three Sixty West", "Lodha Altamount"]
      : brand.industry === "Restaurant"
        ? ["Pizza Papa Cipolla", "Big Mario's Pizza", "Slice Society"]
        : ["Petal & Post", "The Flower Room"];

  return names.map((name) => ({
    id: id("comp"),
    brandId: brand.id,
    name,
    handle: `@${slug(name)}`,
    followers: rng.int(6000, 60000),
    followerDelta30d: rng.int(150, 2400),
    postsPerWeek: rng.int(5, 12),
    avgEngagementRate: rng.float(1.8, 6.4),
    topFormat: rng.pick(["reel", "carousel", "feed"]) as PostFormat,
    estimatedAdSpend30d: rng.int(800, 9000),
    rating: Number(rng.float(3.1, 4.9).toFixed(1)),
    reviewCount: rng.int(40, 480),
  }));
}

function buildConversations(brand: Brand, posts: Post[]): Conversation[] {
  const samples: Array<[Conversation["kind"], string, string, boolean]> = [
    ["dm", "Sofia L.", "Hi! Do you have availability for 2 nights in October? And is the pool heated?", true],
    ["comment", "@markj", "How much for the weekend package?", true],
    ["comment", "@travel.with.us", "This looks unreal 😍", false],
    ["dm", "Peter K.", "We booked last month and the invoice hasn't arrived — can you check?", false],
    ["mention", "@lisboaguide", "Featured @villaserena in our weekend list this week", false],
    ["comment", "@anna.r", "Is there parking on site?", true],
    ["dm", "Group booking", "Looking for 6 rooms for a wedding party in June. Who do I speak to?", true],
  ];
  const whatsappSamples: Array<[string, string, boolean]> = [
    ["+351 912 004 118", "Hi! Is the villa free the weekend of the 14th? Two adults.", true],
    ["Ines M. (+351 934 771 202)", "Thank you for the lovely stay — we left a review 🙏", false],
    ["+44 7700 900412", "Do you have an airport shuttle, and what does it cost?", true],
  ];
  const base: Conversation[] = samples.map(([kind, author, text, isLead], i) => ({
    id: id("conv"),
    brandId: brand.id,
    channel: rng.pick(["instagram", "facebook"]) as ChannelId,
    kind,
    author,
    text,
    createdAt: addDays(TODAY, -i).toISOString(),
    postId: posts.find((p) => p.status === "published")?.id,
    status: (i > 4 ? "replied" : "open") as Conversation["status"],
    sentiment: text.includes("hasn't") ? "negative" : text.includes("unreal") ? "positive" : "neutral",
    isLead,
    draftReply: isLead
      ? `Hi ${author.split(" ")[0].replace("@", "")} — yes! Sending you the details now. What dates are you looking at?`
      : undefined,
  }));

  const wa: Conversation[] = whatsappSamples.map(([author, text, isLead], i) => ({
    id: id("conv"),
    brandId: brand.id,
    channel: "whatsapp",
    kind: "dm",
    author,
    text,
    // Inside the 24-hour service window, so a free-form reply is allowed.
    createdAt: new Date(TODAY.getTime() - (i + 1) * 3 * 3600_000).toISOString(),
    status: i === 1 ? "replied" : "open",
    sentiment: i === 1 ? "positive" : "neutral",
    isLead,
    draftReply: isLead ? "Yes — we have availability. Want me to hold it for 24 hours while you decide?" : undefined,
  }));

  return [...wa, ...base];
}

function buildIdeas(brand: Brand): Idea[] {
  const topics = TOPICS[brand.industry] ?? TOPICS["Restaurant"];
  const reasons = [
    "Your reviews mention this theme 6 times in 30 days — answer it publicly before people have to ask.",
    "Reels outperform your feed posts 2.2x and you have published only 3 this month.",
    "Competitors are covering this weekly and you are not on the topic at all.",
    "Seasonal: search interest for this peaks in the next 3 weeks.",
    "Your best-performing post of the quarter used this angle — the follow-up is overdue.",
  ];
  return topics.slice(0, 8).map((t, i) => ({
    id: id("idea"),
    brandId: brand.id,
    title: t,
    angle: rng.pick(["Behind the scenes", "Myth-buster", "Before/after", "Answer a real question", "One-take tour"]),
    format: rng.pick(["reel", "carousel", "story"]) as PostFormat,
    hook: `${t} — and the part nobody shows you.`,
    outline: ["Open on motion, no logo", "State the payoff in 3s", "Show the proof", "One clear ask at the end"],
    reason: reasons[i % reasons.length],
    score: Number(rng.float(62, 96).toFixed(0)),
    createdAt: addDays(TODAY, -rng.int(0, 6)).toISOString(),
    used: false,
  }));
}

function buildActivity(brand: Brand) {
  const items = [
    ["ai", "suggestion", "Flagged 'Evergreen Suite Tour' for creative fatigue (frequency 4.6x)"],
    ["ai", "publish", "Published reel to Instagram, Facebook and TikTok"],
    ["ai", "review", "Drafted 3 review replies awaiting approval"],
    ["system", "sync", "Synced Meta Ads insights — 45 days, 540 rows"],
    ["Ana", "approval", "Approved 4 posts for next week"],
    ["ai", "qa", "Added Q&A to Google Business Profile"],
    ["system", "sync", "Google Business Profile insights refreshed"],
  ] as const;
  return items.map(([actor, kind, message], i) => ({
    id: id("act"),
    brandId: brand.id,
    at: addDays(TODAY, 0).toISOString().replace("T09", `T${String(8 - i).padStart(2, "0")}`),
    actor,
    kind,
    message,
  }));
}

/**
 * One board per brand, seeded with a HITL "Pending Approval" column plus a
 * couple of orphan cards from a column that was deleted — so the orphan-recovery
 * banner is visible on first load instead of being an untested edge case.
 */
function buildBoard(brand: Brand, posts: Post[]): { board: Board; cards: BoardCard[] } {
  const board = makeBoard(brand.id, `${brand.name} Board`, "content");
  const [ideas, drafting, approval, scheduled, published] = board.columns;

  const rows: Array<[BoardColumn, string, string | undefined, BoardCard["priority"], number, string[], string | undefined, string | undefined]> = [
    [approval, "Sunset reel — final cut", "Waiting on owner sign-off before it goes to IG + TikTok", "High", 2, ["reel", "approval"], "AI Agent", "pending"],
    [approval, "October rates post", "Copy drafted from the brand brief", "Medium", 4, ["offer"], "AI Agent", "pending"],
    [scheduled, "Behind the pass — Friday", undefined, "High", 1, ["bts"], undefined, "approved"],
    [drafting, "Guest question round-up", "Pulled from 6 repeated DM questions", "Medium", 5, ["faq"], "AI Agent", undefined],
    [ideas, "Winter campaign concepts", undefined, "Low", 14, ["campaign"], undefined, undefined],
    [published, "Terrace at golden hour", undefined, "Medium", -3, ["reel"], undefined, "approved"],
    [published, "Spa treatment menu", undefined, "Low", -8, ["spa"], undefined, "approved"],
  ];

  const now = new Date();
  const cards: BoardCard[] = rows.map(([col, title, description, priority, dueInDays, tags, automationLabel, approvalState], i) => ({
    id: id("bcard"),
    boardId: board.id,
    brandId: brand.id,
    columnId: col.id,
    title,
    description,
    priority,
    dueDate: isoDay(addDays(now, dueInDays)),
    tags,
    assignee: rng.pick(["Ana", "Marco", "Koushik", "Logan"]),
    automationLabel,
    approval: approvalState
      ? {
          state: approvalState as "pending" | "approved",
          at: approvalState === "approved" ? addDays(now, -rng.int(1, 20)).toISOString() : undefined,
          by: approvalState === "approved" ? "Ana" : undefined,
        }
      : undefined,
    linkedPostId: posts.find((p) => p.status === "scheduled")?.id,
    order: i,
    createdAt: addDays(now, -rng.int(1, 30)).toISOString(),
    updatedAt: now.toISOString(),
  }));

  // Two cards stranded by a column that used to exist. The board must offer to
  // rehome them rather than pretending they were never there.
  const ghostColumnId = "col_removed_sprint";
  cards.push(
    ...["Set up competitor tracking", "Conduct 5 win/loss interviews"].map((title, i) => ({
      id: id("bcard"),
      boardId: board.id,
      brandId: brand.id,
      columnId: ghostColumnId,
      title,
      tags: ["research"],
      priority: "Medium" as const,
      assignee: "Marco",
      order: i,
      createdAt: addDays(now, -40).toISOString(),
      updatedAt: addDays(now, -40).toISOString(),
    })),
  );

  return { board, cards };
}

function buildReport(brandId: string) {
  return {
    id: id("report"),
    brandId,
    name: "Monthly performance — client ready",
    blocks: [
      { id: id("blk"), type: "ai_summary" as const, title: "Executive summary", config: {} },
      { id: id("blk"), type: "kpi_row" as const, title: "Headline metrics", config: {} },
      { id: id("blk"), type: "timeseries" as const, title: "Reach & engagement", config: { metric: "impressions" } },
      { id: id("blk"), type: "channel_table" as const, title: "Channel breakdown", config: {} },
      { id: id("blk"), type: "ads_summary" as const, title: "Paid performance", config: {} },
      { id: id("blk"), type: "top_posts" as const, title: "Top content", config: { limit: 5 } },
      { id: id("blk"), type: "reviews" as const, title: "Reputation", config: {} },
      { id: id("blk"), type: "rank_grid" as const, title: "Local visibility", config: {} },
    ],
    range: { from: isoDay(addDays(TODAY, -29)), to: isoDay(TODAY) },
    schedule: { cadence: "monthly" as const, recipients: ["client@example.com"], day: 1 },
    createdAt: TODAY.toISOString(),
  };
}
