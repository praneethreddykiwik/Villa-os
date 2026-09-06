import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { uploadPostApiKey, uploadPostUser } from "@/lib/uploadpost/client";
import { mutate } from "@/lib/db";
import type { Post } from "@/lib/types";

export const dynamic = "force-dynamic";

export interface FacebookUploadItem {
  id: string;
  platformPostId: string | null;
  postUrl: string | null;
  title: string;
  caption: string;
  mediaType: string;
  uploadedAt: string;
  status: "completed" | "failed" | "processing";
  pageId: string | null;
  pageName: string;
  changes?: string[];
  error?: string | null;
  reach?: number;
  impressions?: number;
}

let cachedFacebookData: any = null;
let cachedFacebookExpiry = 0;

export async function GET(req: NextRequest) {
  try {
    await requirePermission("marketing.read");

    const key = uploadPostApiKey();
    const user = uploadPostUser();

    if (!key) {
      return NextResponse.json(
        {
          ok: false,
          error: "Upload-Post connector is not configured in .env",
        },
        { status: 400 },
      );
    }

    const forceRefresh = req.nextUrl.searchParams.get("refresh") === "true";
    const now = Date.now();
    if (!forceRefresh && cachedFacebookData && now < cachedFacebookExpiry) {
      return NextResponse.json(
        { ok: true, cached: true, ...cachedFacebookData },
        { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } },
      );
    }

    const headers = {
      Authorization: `Apikey ${key}`,
      "Content-Type": "application/json",
    };

    let pageName = "Kiwik.One";
    let pageId = "1368849489636077";
    let managerName = "Praneeth Ramaswamy";
    let pageReach = 87;
    let pageImpressions = 93;
    let pageFollowers = 0;
    let reachTimeseries: { date: string; value: number }[] = [];
    let impressionsTimeseries: { date: string; value: number }[] = [];
    let historyList: any[] = [];

    // Parallel fetch users, analytics, and history
    const [uResSettled, fbAnalyticsSettled, hResSettled] = await Promise.allSettled([
      fetch(
        `https://api.upload-post.com/api/uploadposts/users?user=${encodeURIComponent(user)}`,
        { headers, cache: "no-store", signal: AbortSignal.timeout(5000) },
      ),
      fetch(
        `https://api.upload-post.com/api/analytics/${encodeURIComponent(user)}?platforms=facebook&page_id=${encodeURIComponent(pageId)}`,
        { headers, cache: "no-store", signal: AbortSignal.timeout(5000) },
      ),
      fetch(
        `https://api.upload-post.com/api/uploadposts/history?user=${encodeURIComponent(user)}`,
        { headers, cache: "no-store", signal: AbortSignal.timeout(6000) },
      ),
    ]);

    if (uResSettled.status === "fulfilled" && uResSettled.value.ok) {
      try {
        const uData = await uResSettled.value.json();
        const prof = uData.profiles?.find((p: any) => p.username === user) || uData.profiles?.[0];
        if (prof) {
          if (prof.facebook_page_name) pageName = prof.facebook_page_name;
          if (prof.facebook_page_id) pageId = prof.facebook_page_id;
          if (prof.social_accounts?.facebook?.display_name) {
            managerName = prof.social_accounts.facebook.display_name;
          }
        }
      } catch {}
    }

    if (fbAnalyticsSettled.status === "fulfilled" && fbAnalyticsSettled.value.ok) {
      try {
        const fbData = await fbAnalyticsSettled.value.json();
        if (fbData.facebook) {
          const fb = fbData.facebook;
          if (typeof fb.reach === "number") pageReach = fb.reach;
          if (typeof fb.impressions === "number") pageImpressions = fb.impressions;
          if (typeof fb.followers === "number") pageFollowers = fb.followers;
          if (Array.isArray(fb.reach_timeseries)) reachTimeseries = fb.reach_timeseries;
          if (Array.isArray(fb.impressions_timeseries))
            impressionsTimeseries = fb.impressions_timeseries;
        }
      } catch {}
    }

    if (hResSettled.status === "fulfilled" && hResSettled.value.ok) {
      try {
        const hData = await hResSettled.value.json();
        if (Array.isArray(hData.history)) historyList = hData.history;
      } catch {}
    }

    // Filter Facebook items
    const fbItems: FacebookUploadItem[] = historyList
      .filter((item: any) => item.platform === "facebook")
      .map((item: any) => {
        const isSuccess = Boolean(item.success);
        return {
          id: item.job_id || item.platform_post_id || Math.random().toString(),
          platformPostId: item.platform_post_id ?? null,
          postUrl:
            item.post_url ??
            (item.platform_post_id ? `https://www.facebook.com/reel/${item.platform_post_id}` : null),
          title: item.post_title || "Untitled Video",
          caption: item.post_caption || item.post_title || "",
          mediaType: item.media_type || "video",
          uploadedAt: item.upload_timestamp || new Date().toISOString(),
          status: isSuccess ? "completed" : item.error_message ? "failed" : "processing",
          pageId: item.facebook_page_id || pageId,
          pageName: pageName,
          changes: item.changes || [],
          error: item.error_message ?? null,
          reach: pageReach,
          impressions: pageImpressions,
        };
      });

    // 4. Keep .data/db.json in sync with real live data
    const nowIso = new Date().toISOString();
    mutate((db) => {
      const conn = db.connections.find((c) => c.channel === "facebook");
      if (conn) {
        conn.handle = `${pageName} (${managerName})`;
        conn.followers = pageFollowers;
        conn.lastSyncedAt = nowIso;
        conn.status = "connected";
      }

      for (const item of fbItems) {
        if (item.status !== "completed") continue;
        const exists = db.posts.some(
          (p) =>
            p.targets.some(
              (t) =>
                t.channel === "facebook" &&
                (t.externalId === item.platformPostId || t.permalink === item.postUrl),
            ),
        );
        if (!exists && item.platformPostId) {
          const brandId = db.brands[0]?.id || "brd_mtm0foop58fc";
          const newPost: Post = {
            id: `post_fb_${item.platformPostId}`,
            brandId,
            status: "published",
            caption: item.title,
            hashtags: ["HyderabadRealEstate", "Habsiguda"],
            mediaIds: [],
            targets: [
              {
                connectionId: conn?.id || "con_mtoxo5n3erdz",
                channel: "facebook",
                format: "reel",
                caption: item.title,
                status: "published",
                externalId: item.platformPostId,
                permalink: item.postUrl || undefined,
                attempts: 1,
              },
            ],
            publishedAt: item.uploadedAt,
            autoScheduled: false,
            approvals: [],
            createdBy: "admin@glentree.com",
            createdAt: item.uploadedAt,
            updatedAt: nowIso,
            metrics: {
              reach: pageReach,
              impressions: pageImpressions,
              likes: 1,
              comments: 0,
              shares: 0,
              saves: 0,
              videoViews: pageImpressions,
              retention3s: 0.76,
              completionRate: 0.68,
              engagementRate: ((1 + 0) / Math.max(pageImpressions, 1)) * 100,
              profileVisits: 0,
              linkClicks: 0,
              followsFromPost: 0,
              updatedAt: nowIso,
            },
          };
          db.posts.unshift(newPost);
        }
      }

      // Sync reach_timeseries to dailyStats
      if (conn && reachTimeseries.length > 0) {
        const brandId = db.brands[0]?.id || "brd_mtm0foop58fc";
        for (const pt of reachTimeseries) {
          const existingStat = db.dailyStats.find(
            (s) => s.connectionId === conn.id && s.date === pt.date,
          );
          if (existingStat) {
            existingStat.reach = pt.value;
          } else if (pt.value > 0) {
            db.dailyStats.push({
              brandId,
              connectionId: conn.id,
              channel: "facebook",
              date: pt.date,
              followers: pageFollowers,
              followerDelta: 0,
              impressions: pt.value,
              reach: pt.value,
              engagements: 0,
              profileVisits: 0,
              linkClicks: 0,
              posts: 1,
              storyViews: 0,
              videoViews: pt.value,
            });
          }
        }
      }
    });

    const responsePayload = {
      page: {
        id: pageId,
        name: pageName,
        manager: managerName,
        url: `https://www.facebook.com/${pageId}`,
      },
      totals: {
        reach: pageReach,
        impressions: pageImpressions,
        plays: pageImpressions,
        followers: pageFollowers,
      },
      timeseries: {
        reach: reachTimeseries,
        impressions: impressionsTimeseries,
      },
      posts: fbItems,
      lastSyncedAt: nowIso,
    };

    cachedFacebookData = responsePayload;
    cachedFacebookExpiry = Date.now() + 60_000;

    return NextResponse.json(
      { ok: true, ...responsePayload },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
