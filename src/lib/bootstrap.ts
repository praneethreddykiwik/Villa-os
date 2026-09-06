import type { Brand, Database, Workspace } from "./types";
import { EMPTY_OPS } from "./ops/types";
import { uid } from "./ids";

/**
 * TENANT BOOTSTRAP — configuration only, never content.
 *
 * This replaces the former `seed.ts`, which fabricated a 200-day dataset of
 * posts, ad spend, reviews, rank grids and leads so that every screen had
 * something to render on first load. That data is gone: dashboards that invent
 * their own numbers are worse than empty ones, because there is no way to tell
 * a real figure from a generated one once they are side by side.
 *
 * What remains is the minimum shape the application needs to function at all —
 * one workspace and one brand — mirroring the `organizations` and `projects`
 * rows that migration 0003 creates in Postgres. Every collection that holds
 * business records starts empty and is filled only by real activity.
 */

/** Mirrors the `organizations` row created by 0003_glentree_bootstrap.sql. */
const ORG_NAME = "Glentree";
const BRAND_NAME = "Glentree Villas";
const TIMEZONE = "Asia/Kolkata";

/**
 * The brand carries the copy brief the AI engines condition on. It is left
 * deliberately factual and short rather than filled with invented marketing
 * voice — an operator edits this in Settings, and a placeholder that reads as
 * finished copy tends to ship to production unchanged.
 */
export const DEFAULT_WORKSPACE_ID = "ws_mtiajnoi2b3g";
export const DEFAULT_BRAND_ID = "brd_mtiajnoil4a2";

export function buildBootstrap(): Database {
  const now = new Date().toISOString();

  const workspace: Workspace = {
    id: DEFAULT_WORKSPACE_ID,
    name: ORG_NAME,
    createdAt: now,
  };

  const brand: Brand = {
    id: DEFAULT_BRAND_ID,
    workspaceId: workspace.id,
    name: BRAND_NAME,
    voice: "",
    industry: "Real estate",
    timezone: TIMEZONE,
    color: "#8b8b8b",
    offerings: [],
    audience: "",
    createdAt: now,
  };

  return {
    workspaces: [workspace],
    appointments: [],
    availability: [],
    notificationLog: [],
    webhookSubscribers: [],
    webhookDeliveries: [],
    n8nSubmissions: [],
    brands: [brand],
    connections: [
      {
        id: "conn_yt_kiwik_one",
        brandId: DEFAULT_BRAND_ID,
        channel: "youtube",
        handle: "@kiwik-one",
        externalId: "UCDjreja_dapcIneC5x56Tjg",
        status: "connected",
        scopes: [
          "https://www.googleapis.com/auth/youtube.upload",
          "https://www.googleapis.com/auth/youtube.force-ssl",
          "https://www.googleapis.com/auth/yt-analytics.readonly",
        ],
        avatarColor: "#ef4444",
        followers: 0,
        connectedAt: "2026-09-05T18:22:57.774556Z",
        lastSyncedAt: now,
      },
      {
        id: "conn_ig_kiwik_one",
        brandId: DEFAULT_BRAND_ID,
        channel: "instagram",
        handle: "@kiwik.one1",
        externalId: "kiwik.one1",
        status: "connected",
        scopes: ["instagram_basic", "instagram_content_publish", "pages_show_list"],
        avatarColor: "#ec4899",
        followers: 0,
        connectedAt: "2026-09-05T20:43:22.089Z",
        lastSyncedAt: now,
      },
      {
        id: "con_mtpltlcb809u",
        brandId: DEFAULT_BRAND_ID,
        channel: "facebook",
        handle: "Kiwik.One (Praneeth Ramaswamy)",
        externalId: "uploadpost:default:facebook",
        status: "connected",
        scopes: ["upload-post"],
        avatarColor: "#1877F2",
        followers: 0,
        connectedAt: "2026-09-06T09:23:24.875Z",
        lastSyncedAt: now,
      },
      {
        id: "con_mtpltmzj101d",
        brandId: DEFAULT_BRAND_ID,
        channel: "linkedin",
        handle: "Kiwik.One 1",
        externalId: "uploadpost:default:linkedin",
        status: "connected",
        scopes: ["upload-post"],
        avatarColor: "#0A66C2",
        followers: 0,
        connectedAt: "2026-09-06T09:23:27.006Z",
      },
    ],
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
    voiceCalls: [],
    voiceAgentConfigs: [],
    ...EMPTY_OPS,
  };
}
