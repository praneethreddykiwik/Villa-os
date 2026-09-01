/**
 * Domain model for the whole product. Everything is multi-tenant from day one:
 * a Workspace is an agency, a Brand is one client business. Nothing anywhere in
 * the codebase assumes a single business — that is what makes this a *universal*
 * dashboard you can point at Villa today and at 50 other clients tomorrow.
 */

export type PlatformId =
  | "instagram"
  | "facebook"
  | "tiktok"
  | "youtube"
  | "linkedin"
  | "x"
  | "google_business"
  | "whatsapp";

export type AdPlatformId = "meta_ads" | "google_ads";

export type ChannelId = PlatformId | AdPlatformId;

export type PostFormat = "feed" | "reel" | "story" | "carousel" | "short" | "text";

export type PostStatus =
  | "idea"
  | "draft"
  | "needs_approval"
  | "approved"
  | "scheduled"
  | "publishing"
  | "published"
  | "failed";

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
}

export interface Brand {
  id: string;
  workspaceId: string;
  name: string;
  /** Free-text brand brief the AI engines condition on. */
  voice: string;
  industry: string;
  timezone: string;
  website?: string;
  /** Hex accent used for the brand's chips across calendar + charts. */
  color: string;
  /** Products/services the AI can reference when writing copy. */
  offerings: string[];
  audience: string;
  createdAt: string;
}

/** A connected account on a platform, e.g. one IG business account. */
export interface Connection {
  id: string;
  brandId: string;
  channel: ChannelId;
  /** Display handle, e.g. @villa.resort */
  handle: string;
  /** Platform-side identifier (IG user id, page id, act_xxx, customer id). */
  externalId: string;
  status: "connected" | "expired" | "error" | "disconnected";
  /** Never render this. Stored server-side only. */
  accessToken?: string;
  /**
   * Issued by Google, TikTok and X alongside the access token. Without storing
   * it, those connections die at the first expiry and have to be re-authorised
   * by hand instead of refreshed.
   */
  refreshToken?: string;
  tokenExpiresAt?: string;
  scopes: string[];
  avatarColor: string;
  followers: number;
  connectedAt: string;
  lastSyncedAt?: string;
  lastError?: string;
}

export interface MediaAsset {
  id: string;
  brandId: string;
  kind: "video" | "image";
  /** Source file path or URL. */
  src: string;
  posterSrc?: string;
  width: number;
  height: number;
  durationSec?: number;
  /** Edit recipe applied by the Studio; rendered by the ffmpeg pipeline. */
  edit?: MediaEdit;
  /** Renders keyed by aspect ratio, e.g. { "9:16": "/renders/x-9x16.mp4" }. */
  renders: Record<string, string>;
  createdAt: string;
  tags: string[];
}

export interface MediaEdit {
  trimStartSec: number;
  trimEndSec: number;
  aspect: "9:16" | "1:1" | "4:5" | "16:9";
  /** Focal point 0..1 used when cropping to a different aspect. */
  focalX: number;
  focalY: number;
  captionsEnabled: boolean;
  captionStyle: "bold-center" | "karaoke" | "subtle-bottom";
  overlays: MediaOverlay[];
  musicTrackId?: string;
  musicVolume: number;
  /** Speed ramp; 1 = untouched. */
  speed: number;
  brightness: number;
  saturation: number;
}

export interface MediaOverlay {
  id: string;
  type: "text" | "logo" | "cta";
  text?: string;
  x: number;
  y: number;
  startSec: number;
  endSec: number;
  size: number;
  color: string;
}

/** One piece of content, fanned out to N channels. */
export interface Post {
  id: string;
  brandId: string;
  status: PostStatus;
  /** Master copy; per-target overrides live on the target. */
  caption: string;
  hashtags: string[];
  mediaIds: string[];
  targets: PostTarget[];
  /** ISO. When every target should go out unless the target overrides it. */
  scheduledAt?: string;
  publishedAt?: string;
  /** Set when the best-time engine chose the slot rather than a human. */
  autoScheduled: boolean;
  campaignId?: string;
  approvals: Approval[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Populated after publish by the metrics sync. */
  metrics?: PostMetrics;
  aiNotes?: string[];
}

export interface PostTarget {
  connectionId: string;
  channel: ChannelId;
  format: PostFormat;
  /** Per-network copy override; falls back to Post.caption. */
  caption?: string;
  scheduledAt?: string;
  status: PostStatus;
  /** Platform id of the published object. */
  externalId?: string;
  permalink?: string;
  error?: string;
  attempts: number;
  /** Story-only: interactive sticker config. */
  stickers?: StorySticker[];
  firstComment?: string;
}

export interface StorySticker {
  type: "poll" | "question" | "link" | "location" | "mention" | "countdown";
  value: string;
  options?: string[];
}

export interface Approval {
  by: string;
  at: string;
  decision: "approved" | "changes_requested";
  note?: string;
}

export interface PostMetrics {
  impressions: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  videoViews: number;
  /** Reels/Shorts: fraction that watched to the end. */
  completionRate: number;
  /** Fraction still watching at 3s — the hook score. */
  retention3s: number;
  profileVisits: number;
  linkClicks: number;
  followsFromPost: number;
  engagementRate: number;
  updatedAt: string;
}

/** A daily metric row per connection — the spine of every chart. */
export interface DailyStat {
  brandId: string;
  connectionId: string;
  channel: ChannelId;
  date: string; // YYYY-MM-DD
  followers: number;
  followerDelta: number;
  impressions: number;
  reach: number;
  engagements: number;
  profileVisits: number;
  linkClicks: number;
  posts: number;
  storyViews: number;
  videoViews: number;
}

export interface AdCampaign {
  id: string;
  brandId: string;
  connectionId: string;
  platform: AdPlatformId;
  name: string;
  objective: string;
  status: "active" | "paused" | "ended" | "learning";
  dailyBudget: number;
  lifetimeSpend: number;
  startDate: string;
  endDate?: string;
  adSets: AdSet[];
}

export interface AdSet {
  id: string;
  campaignId: string;
  name: string;
  audience: string;
  placements: string[];
  ads: Ad[];
}

export interface Ad {
  id: string;
  adSetId: string;
  name: string;
  /** Links an ad back to the organic post it was boosted from. */
  sourcePostId?: string;
  creativeThumb: string;
  format: PostFormat;
  status: "active" | "paused";
}

/** Daily ad performance row. Mirrors the Meta Insights + Google Ads field sets. */
export interface AdStat {
  brandId: string;
  platform: AdPlatformId;
  campaignId: string;
  adSetId: string;
  adId: string;
  date: string;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  conversionValue: number;
  /** Meta: avg times a person saw the ad. The creative-fatigue input. */
  frequency: number;
  reach: number;
  videoPlays: number;
  thruPlays: number;
}

export interface Review {
  id: string;
  brandId: string;
  source: "google" | "facebook" | "tripadvisor" | "booking";
  author: string;
  rating: number;
  text: string;
  createdAt: string;
  replied: boolean;
  reply?: string;
  repliedAt?: string;
  /** AI-drafted reply awaiting a human click. */
  draftReply?: string;
  sentiment: "positive" | "neutral" | "negative";
  topics: string[];
}

/** One cell of the local rank grid (the map-with-numbers view). */
export interface RankGridCell {
  brandId: string;
  keyword: string;
  row: number;
  col: number;
  lat: number;
  lng: number;
  rank: number; // 1..20, 20 = not in top 20
  capturedAt: string;
}

export interface Competitor {
  id: string;
  brandId: string;
  name: string;
  handle: string;
  followers: number;
  followerDelta30d: number;
  postsPerWeek: number;
  avgEngagementRate: number;
  topFormat: PostFormat;
  estimatedAdSpend30d: number;
  rating: number;
  reviewCount: number;
}

export type SuggestionSeverity = "critical" | "opportunity" | "info";

/** Output of the AI insight engine — the "what should I do next" feed. */
export interface Suggestion {
  id: string;
  brandId: string;
  /** Which analyser produced it. */
  kind:
    | "creative_fatigue"
    | "budget_shift"
    | "boost_organic"
    | "posting_time"
    | "format_mix"
    | "hook_quality"
    | "hashtag"
    | "anomaly"
    | "pacing"
    | "review_response"
    | "local_visibility"
    | "competitor"
    | "cadence";
  severity: SuggestionSeverity;
  title: string;
  /** Human-readable reasoning, always citing the numbers it used. */
  rationale: string;
  /** Quantified upside so suggestions can be ranked against each other. */
  projectedImpact: { metric: string; value: number; unit: string };
  /** Machine-executable action the UI turns into a one-click button. */
  action?: SuggestionAction;
  entity?: { type: "post" | "campaign" | "adset" | "ad" | "connection" | "review"; id: string; label: string };
  confidence: number; // 0..1
  createdAt: string;
  state: "new" | "accepted" | "dismissed" | "done";
}

export interface SuggestionAction {
  type:
    | "pause_ad"
    | "shift_budget"
    | "boost_post"
    | "reschedule"
    | "generate_variants"
    | "reply_review"
    | "change_format"
    | "raise_budget"
    | "lower_budget";
  label: string;
  params: Record<string, string | number>;
}

export interface Campaign {
  id: string;
  brandId: string;
  name: string;
  goal: string;
  startDate: string;
  endDate: string;
  color: string;
}

export interface Conversation {
  id: string;
  brandId: string;
  channel: ChannelId;
  kind: "comment" | "dm" | "mention" | "review";
  /**
   * Display string only — "Name (+number)" for WhatsApp. The name half comes
   * from the sender's own profile, so nothing may be parsed out of this and
   * used as an address or an identity. Reply to `authorId`.
   */
  author: string;
  /**
   * The platform's own verified sender id (the WhatsApp `wa_id`), recorded at
   * ingest from the signature-verified payload. Absent on conversations
   * imported from channels that do not expose a repliable id.
   */
  authorId?: string;
  text: string;
  createdAt: string;
  postId?: string;
  status: "open" | "replied" | "closed";
  sentiment: "positive" | "neutral" | "negative";
  /** Set when the triage engine thinks this is a lead worth chasing. */
  isLead: boolean;
  draftReply?: string;
  reply?: string;
}

export interface Idea {
  id: string;
  brandId: string;
  title: string;
  angle: string;
  format: PostFormat;
  hook: string;
  outline: string[];
  /** Why now — trend, season, competitor gap, review theme. */
  reason: string;
  score: number;
  createdAt: string;
  used: boolean;
}

export interface Report {
  id: string;
  brandId: string;
  name: string;
  /** Which widget blocks the report renders, in order. */
  blocks: ReportBlock[];
  range: { from: string; to: string };
  schedule?: { cadence: "weekly" | "monthly"; recipients: string[]; day: number };
  createdAt: string;
}

export interface ReportBlock {
  id: string;
  type:
    | "kpi_row"
    | "channel_table"
    | "timeseries"
    | "top_posts"
    | "ads_summary"
    | "reviews"
    | "ai_summary"
    | "rank_grid"
    | "text";
  title: string;
  config: Record<string, unknown>;
}

import type { Broker, CrmContact, CrmTask, Lead } from "./crm/types";
import type { OpsDatabase } from "./ops/types";
export type * from "./crm/types";
export type * from "./ops/types";

/* -------------------------------------------------------------------------- */
/* Boards — the fully customisable Monday/Trello-style work surface             */
/* -------------------------------------------------------------------------- */

/** Which optional fields a board shows on cards and in the add form. */
export type BoardFieldKey =
  | "description"
  | "priority"
  | "dueDate"
  | "tags"
  | "assignee"
  | "automationLabel"
  | "linkedPost";

export interface BoardColumn {
  id: string;
  name: string;
  /** Index into COLUMN_COLORS — clicking the dot cycles it. */
  color: string;
  /**
   * Human-in-the-loop. Cards sitting in a HITL column are treated as awaiting a
   * person's approval, and anything automation drops here waits rather than
   * moving on. This is the safety valve for the AI-generated content pipeline.
   */
  hitl: boolean;
  /** Optional WIP limit; the header turns amber past it. */
  wipLimit?: number;
}

export interface BoardCard {
  id: string;
  boardId: string;
  brandId: string;
  /** May point at a deleted column — the board surfaces those as orphans
      rather than dropping the cards on the floor. */
  columnId: string;
  title: string;
  description?: string;
  priority?: "Low" | "Medium" | "High" | "Urgent";
  dueDate?: string;
  tags: string[];
  assignee?: string;
  /** Set when an automation or the AI agent created/moved the card. */
  automationLabel?: string;
  /**
   * Who created the card, taken from the session at creation time. Recorded
   * because an approval gate that the author can clear themselves is not a
   * gate — the approval route needs an author to compare the approver against.
   * Optional only because cards written before this existed have no author.
   */
  createdBy?: string;
  approval?: {
    state: "pending" | "approved" | "rejected";
    at?: string;
    by?: string;
    /** The approver's user id, so the check does not rest on a display name. */
    byId?: string;
    note?: string;
  };
  /** Links a board card to a scheduled post, so approving here can release it. */
  linkedPostId?: string;
  /** Sort position within its column. */
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface Board {
  id: string;
  brandId: string;
  name: string;
  columns: BoardColumn[];
  /** Field visibility, in render order. */
  fields: Record<BoardFieldKey, boolean>;
  templateId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Database {
  workspaces: Workspace[];
  brands: Brand[];
  connections: Connection[];
  media: MediaAsset[];
  posts: Post[];
  dailyStats: DailyStat[];
  adCampaigns: AdCampaign[];
  adStats: AdStat[];
  reviews: Review[];
  rankGrid: RankGridCell[];
  competitors: Competitor[];
  suggestions: Suggestion[];
  campaigns: Campaign[];
  conversations: Conversation[];
  ideas: Idea[];
  reports: Report[];
  activity: ActivityEntry[];
  boards: Board[];
  boardCards: BoardCard[];
  leads: Lead[];
  brokers: Broker[];
  crmContacts: CrmContact[];
  crmTasks: CrmTask[];
}

/** The ops slice is merged into Database so there is one store, one mutate(). */
export interface Database extends OpsDatabase {}

export interface ActivityEntry {
  id: string;
  brandId: string;
  at: string;
  actor: "ai" | "system" | string;
  kind: string;
  message: string;
}
