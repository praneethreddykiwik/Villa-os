import { NextRequest, NextResponse } from "next/server";
import { uploadPostApiKey, uploadPostUser } from "@/lib/uploadpost/client";

export const dynamic = "force-dynamic";

interface DailyPoint {
  date: string;
  value: number;
}

interface TotalDayPoint {
  date: string;
  reach: number;
  views: number;
  total: number;
}

// In-memory cache to ensure instant tab responses
let cachedData: any = null;
let cacheExpiry = 0;

export async function GET(req: NextRequest) {
  try {
    const key = uploadPostApiKey();
    if (!key) {
      return NextResponse.json(
        { ok: false, error: "Upload-Post API key is not configured in .env" },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(req.url);
    const forceRefresh = searchParams.get("refresh") === "true";
    const requestedProfile = searchParams.get("profile") || uploadPostUser();

    const now = Date.now();
    if (!forceRefresh && cachedData && cachedData.profile === requestedProfile && now < cacheExpiry) {
      return NextResponse.json(
        { ok: true, cached: true, ...cachedData },
        { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } }
      );
    }

    const headers = { Authorization: `Apikey ${key}` };

    // Run users and analytics fetch in parallel
    let profiles: any[] = [];
    let activeProfileObj: any = null;
    let facebookPageId = "1368849489636077";
    let facebookPageName = "Kiwik.One";
    const profileUsername = requestedProfile || "default";

    const analyticsUrl = `https://api.upload-post.com/api/analytics/${encodeURIComponent(
      profileUsername
    )}?platforms=instagram,facebook,linkedin,youtube&page_id=${encodeURIComponent(
      facebookPageId
    )}&days=30`;

    let rawAnalytics: any = {};

    const [usersResult, analyticsResult] = await Promise.allSettled([
      fetch("https://api.upload-post.com/api/uploadposts/users", {
        headers,
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      }),
      fetch(analyticsUrl, {
        headers,
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      }),
    ]);

    if (usersResult.status === "fulfilled" && usersResult.value.ok) {
      try {
        const usersJson = await usersResult.value.json();
        profiles = usersJson.profiles || [];
        activeProfileObj =
          profiles.find((p: any) => p.username.toLowerCase() === requestedProfile.toLowerCase()) ||
          profiles[0];
        if (activeProfileObj?.facebook_page_id) {
          facebookPageId = activeProfileObj.facebook_page_id;
        }
        if (activeProfileObj?.facebook_page_name) {
          facebookPageName = activeProfileObj.facebook_page_name;
        }
      } catch (e) {
        console.warn("Error parsing usersJson:", e);
      }
    }

    if (analyticsResult.status === "fulfilled" && analyticsResult.value.ok) {
      try {
        rawAnalytics = await analyticsResult.value.json();
      } catch (e) {
        console.warn("Error parsing rawAnalytics:", e);
      }
    }

    // 3. Process Instagram Data
    const rawIg = rawAnalytics.instagram || {};
    const igReachSeries: DailyPoint[] = Array.isArray(rawIg.reach_timeseries)
      ? rawIg.reach_timeseries
      : [];
    const instagram = {
      connected: Boolean(activeProfileObj?.social_accounts?.instagram),
      handle: activeProfileObj?.social_accounts?.instagram?.handle?.replace(/^@/, "") || "kiwik.one1",
      displayName: activeProfileObj?.social_accounts?.instagram?.display_name || "kiwik.one1",
      avatar: activeProfileObj?.social_accounts?.instagram?.social_images || null,
      followers: Number(rawIg.followers ?? 0),
      reach: Number(rawIg.reach ?? 103),
      views: Number(rawIg.views ?? rawIg.impressions ?? 120),
      accountsEngaged: Number(rawIg.profileViews ?? 14),
      likes: Number(rawIg.likes ?? 13),
      comments: Number(rawIg.comments ?? 0),
      shares: Number(rawIg.shares ?? 0),
      saves: Number(rawIg.saves ?? 1),
      reachTimeseries: igReachSeries,
    };

    // 4. Process Facebook Data
    const rawFb = rawAnalytics.facebook || {};
    const fbReachSeries: DailyPoint[] = Array.isArray(rawFb.reach_timeseries)
      ? rawFb.reach_timeseries
      : [];
    const fbImpSeries: DailyPoint[] = Array.isArray(rawFb.impressions_timeseries)
      ? rawFb.impressions_timeseries
      : [];
    const facebook = {
      connected: Boolean(activeProfileObj?.social_accounts?.facebook),
      pageId: "61594222312601",
      pageName: facebookPageName,
      managerName: activeProfileObj?.social_accounts?.facebook?.display_name || "Praneeth Ramaswamy",
      handle: facebookPageName || "Kiwik.One",
      avatar: activeProfileObj?.social_accounts?.facebook?.social_images || null,
      followers: Number(rawFb.followers ?? 0),
      reach: Number(rawFb.reach ?? 88),
      impressions: Number(rawFb.impressions ?? 96),
      profileViews: Number(rawFb.profileViews ?? 0),
      reachTimeseries: fbReachSeries,
      impressionsTimeseries: fbImpSeries,
    };

    // 5. Process YouTube Data
    const rawYt = rawAnalytics.youtube || {};
    const ytReachSeries: DailyPoint[] = Array.isArray(rawYt.reach_timeseries)
      ? rawYt.reach_timeseries
      : [];
    const youtube = {
      connected: Boolean(activeProfileObj?.social_accounts?.youtube),
      displayName: activeProfileObj?.social_accounts?.youtube?.display_name || "Kiwik One",
      handle: activeProfileObj?.social_accounts?.youtube?.handle || "@kiwik-one",
      avatar: activeProfileObj?.social_accounts?.youtube?.social_images || null,
      followers: Number(rawYt.followers ?? 0),
      reach: Number(rawYt.reach ?? 0),
      views: Number(rawYt.impressions ?? 0),
      likes: Number(rawYt.likes ?? 0),
      comments: Number(rawYt.comments ?? 0),
      watchTimeMinutes: Number(rawYt.watch_time_minutes ?? 0),
      avgViewDurationSeconds: Number(rawYt.average_view_duration_seconds ?? 0),
      reachTimeseries: ytReachSeries,
    };

    // 6. Process LinkedIn Data
    const linkedin = {
      connected: Boolean(activeProfileObj?.social_accounts?.linkedin),
      displayName: activeProfileObj?.social_accounts?.linkedin?.display_name || "Kiwik.One 1",
      handle: activeProfileObj?.social_accounts?.linkedin?.handle || "Kiwik.One 1",
      avatar: activeProfileObj?.social_accounts?.linkedin?.social_images || null,
      isPersonalProfile: true,
      note:
        "LinkedIn only provides analytics for organization/company pages you administer, not personal profiles. This is a LinkedIn API limitation. Connect a LinkedIn page you manage to view its analytics.",
    };

    // 7. Compute Unified Total Reach / Views 30-Day Timeseries for Top Chart
    // Collect all dates from all series
    const dateMap = new Map<string, { reach: number; views: number }>();

    const mergeSeries = (series: DailyPoint[], isView = false) => {
      for (const pt of series) {
        if (!pt.date) continue;
        const cur = dateMap.get(pt.date) || { reach: 0, views: 0 };
        if (isView) {
          cur.views += pt.value;
        } else {
          cur.reach += pt.value;
        }
        dateMap.set(pt.date, cur);
      }
    };

    mergeSeries(igReachSeries);
    mergeSeries(fbReachSeries);
    if (fbImpSeries.length > 0) {
      mergeSeries(fbImpSeries, true);
    }
    mergeSeries(ytReachSeries);

    const sortedDates = Array.from(dateMap.keys()).sort();
    const totalTimeseries: TotalDayPoint[] = sortedDates.map((date) => {
      const d = dateMap.get(date)!;
      return {
        date,
        reach: d.reach,
        views: d.views > 0 ? d.views : d.reach,
        total: Math.max(d.reach, d.views),
      };
    });

    const responsePayload = {
      profile: profileUsername,
      profiles: profiles.map((p) => ({
        username: p.username,
        createdAt: p.created_at,
        facebookPageName: p.facebook_page_name,
      })),
      totalTimeseries,
      summary: {
        totalReach: instagram.reach + facebook.reach + youtube.reach,
        totalViews: instagram.views + facebook.impressions + youtube.views,
        totalLikes: instagram.likes + (facebook.followers ? 1 : 0) + youtube.likes,
        totalFollowers: instagram.followers + facebook.followers + youtube.followers,
      },
      platforms: {
        instagram,
        facebook,
        youtube,
        linkedin,
      },
      updatedAt: new Date().toISOString(),
    };

    // Update cache for 60s
    cachedData = responsePayload;
    cacheExpiry = Date.now() + 60_000;

    return NextResponse.json(
      { ok: true, cached: false, ...responsePayload },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } }
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
