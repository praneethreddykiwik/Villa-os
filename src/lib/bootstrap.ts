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
export function buildBootstrap(): Database {
  const now = new Date().toISOString();

  const workspace: Workspace = {
    id: uid("ws"),
    name: ORG_NAME,
    createdAt: now,
  };

  const brand: Brand = {
    id: uid("brd"),
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
    // Everything below is business content. It stays empty until something real
    // creates it — a publish, a sync, a webhook, a form submission.
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
    voiceCalls: [],
    voiceAgentConfigs: [],
    ...EMPTY_OPS,
  };
}
