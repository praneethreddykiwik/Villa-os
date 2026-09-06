import assert from "node:assert/strict";
import test, { after, describe } from "node:test";
import { cleanup, isolate } from "./helpers";
import type { DailyStat } from "../src/lib/types";

/**
 * Publishing-connector analytics: mapping from the real payload shape, the
 * per-day / delta arithmetic behind dailyStats, the Refresh throttle, and the
 * LinkedIn / Facebook "cannot report" states. All pure — no network.
 */
const dir = isolate("uploadpost-analytics");
process.env.UPLOAD_POST_API_KEY = "test-key";
after(() => cleanup(dir));

const a = require("../src/lib/uploadpost/analytics") as typeof import("../src/lib/uploadpost/analytics");
const s = require("../src/lib/engine/uploadpost-sync") as typeof import("../src/lib/engine/uploadpost-sync");
const { read, mutate, resetToBootstrap } = require("../src/lib/db") as typeof import("../src/lib/db");

/** Trimmed from a real GET /api/analytics/{profile} response. */
const PAYLOAD = {
  instagram: {
    followers: 0, reach: 104, views: 121, impressions: 121, profileViews: 15, likes: 13, comments: 0, shares: 0, saves: 1,
    reach_timeseries: [{ date: "2026-09-04", value: 10 }, { date: "2026-09-05", value: 40 }, { date: "2026-09-06", value: 54 }],
    available_metrics: ["followers", "reach"], metric_labels: { reach: "Unique Reach", views: "Views" }, primary_impressions_field: "reach",
  },
  facebook: { success: false, message: 'Query parameter "page_id" is required' },
  linkedin: { success: false, linkedin_personal_unsupported: true, message: "LinkedIn only provides analytics for organization/company pages you administer, not personal profiles." },
};

describe("mapChannelAnalytics", () => {
  test("maps the instagram slice: totals, sorted series, labels", () => {
    const ig = a.mapChannelAnalytics("instagram", PAYLOAD.instagram);
    assert.equal(ig.ok, true);
    assert.deepEqual(ig.totals, { followers: 0, reach: 104, views: 121, impressions: 121, profileViews: 15, likes: 13, comments: 0, shares: 0, saves: 1 });
    assert.deepEqual(ig.reachSeries.map((p) => p.value), [10, 40, 54]);
    assert.equal(ig.metricLabels.reach, "Unique Reach");
    assert.equal(ig.periodDays, 30);
  });

  test("facebook without a page id is 'page_id_required', linkedin personal is 'personal_unsupported'", () => {
    const fb = a.mapChannelAnalytics("facebook", PAYLOAD.facebook);
    assert.equal(fb.ok, false);
    assert.equal(fb.reason, "page_id_required");
    const li = a.mapChannelAnalytics("linkedin", PAYLOAD.linkedin);
    assert.equal(li.ok, false);
    assert.equal(li.reason, "personal_unsupported");
    assert.match(li.message ?? "", /personal profiles/);
    // A missing slice is an error, never a throw.
    assert.equal(a.mapChannelAnalytics("instagram", undefined).reason, "error");
  });
});

describe("history + post analytics", () => {
  const HISTORY = { history: [
    { platform: "facebook", media_type: "video", upload_timestamp: "2026-09-06T06:36:08.096Z", success: true, platform_post_id: "2021", post_url: "https://www.facebook.com/reel/2021", post_title: "Flat tour" },
    { platform: "instagram", media_type: "video", upload_timestamp: "2026-09-05T06:00:00.000Z", success: true, platform_post_id: "ig1", post_url: "https://instagram.com/p/ig1", post_title: "Reel" },
    { platform: "instagram", media_type: "video", upload_timestamp: "2026-09-07T06:00:00.000Z", success: false, platform_post_id: null, post_url: null, post_title: "Failed", error_message: "bad media" },
  ] };

  test("recentPosts keeps one network's successful uploads, newest first, joined to per-post metrics", () => {
    const history = a.mapHistory(HISTORY);
    assert.equal(history.length, 3);
    const metrics = a.mapPostAnalytics({ posts: [{ platform_post_id: "ig1", views: 50, likes: 4, comments: 1 }] });
    const ig = a.recentPosts("instagram", history, metrics);
    assert.equal(ig.length, 1, "the failed upload is not a post");
    assert.equal(ig[0].metrics?.views, 50);
    assert.equal(ig[0].metrics?.likes, 4);
    const fb = a.recentPosts("facebook", history, metrics);
    assert.equal(fb[0].postUrl, "https://www.facebook.com/reel/2021");
    assert.equal(fb[0].metrics, null, "no per-post figures yet");
    assert.deepEqual(a.mapHistory({}), []);
  });
});

describe("FreshBypassThrottle", () => {
  test("one bypass per window per key, with a countdown", () => {
    let now = 1_000_000;
    const t = new a.FreshBypassThrottle(20_000, () => now);
    assert.equal(t.allow("u1"), true);
    assert.equal(t.allow("u1"), false);
    assert.equal(t.allow("u2"), true, "keys are independent");
    assert.equal(t.retryAfter("u1"), 20);
    now += 19_000;
    assert.equal(t.allow("u1"), false);
    assert.equal(t.retryAfter("u1"), 1);
    now += 1_000;
    assert.equal(t.allow("u1"), true);
    assert.equal(t.retryAfter("nobody"), 0);
  });
});

const conn = { id: "con_ig", brandId: "b1", channel: "instagram" as const };
const ig = a.mapChannelAnalytics("instagram", PAYLOAD.instagram);

describe("planSocialRows", () => {
  test("first sync: series days become reach rows, today's row carries the period totals", () => {
    const rows = s.planSocialRows(conn, [], { analytics: ig, postsInPeriod: 2 }, "2026-09-06");
    assert.deepEqual(rows.map((r) => [r.date, r.reach]), [["2026-09-04", 10], ["2026-09-05", 40], ["2026-09-06", 54]]);
    const today = rows[2];
    assert.equal(today.engagements, 14, "likes + comments + shares + saves");
    assert.equal(today.videoViews, 121);
    assert.equal(today.posts, 2);
    assert.equal(today.followerDelta, 0, "nothing earlier to measure against");
    assert.equal(rows[0].engagements, 0, "period totals are not smeared over earlier days");
  });

  test("re-running the same day rewrites in place and later runs only book growth", () => {
    const first = s.planSocialRows(conn, [], { analytics: ig, postsInPeriod: 2 }, "2026-09-06");
    const again = s.planSocialRows(conn, first, { analytics: ig, postsInPeriod: 2 }, "2026-09-06");
    assert.deepEqual(again, first, "same input, same rows");

    // Next day: views grew 121 → 150, one more post, reach series moved on.
    const grown = a.mapChannelAnalytics("instagram", {
      ...PAYLOAD.instagram, views: 150, likes: 20, followers: 7,
      reach_timeseries: [...PAYLOAD.instagram.reach_timeseries, { date: "2026-09-07", value: 9 }],
    });
    const next = s.planSocialRows(conn, first, { analytics: grown, postsInPeriod: 3 }, "2026-09-07");
    const day7 = next.find((r) => r.date === "2026-09-07")!;
    assert.equal(day7.videoViews, 29, "150 - 121 already booked");
    assert.equal(day7.engagements, 7, "21 - 14 already booked");
    assert.equal(day7.posts, 1);
    assert.equal(day7.reach, 9);
    assert.equal(day7.followerDelta, 7);
    assert.ok(next.every((r) => r.followers === 7), "follower level on every row");
    // Window sum tracks the connector's period total.
    const all = [...first.filter((r) => !next.some((n) => n.date === r.date)), ...next];
    assert.equal(all.reduce((n, r) => n + r.videoViews, 0), 150);
  });

  test("a total that fell below what was booked clamps at 0 rather than going negative", () => {
    const booked: DailyStat[] = [{ brandId: "b1", connectionId: "con_ig", channel: "instagram", date: "2026-09-05", followers: 0, followerDelta: 0, impressions: 0, reach: 0, engagements: 500, profileVisits: 0, linkClicks: 0, posts: 0, storyViews: 0, videoViews: 900 }];
    const rows = s.planSocialRows(conn, booked, { analytics: ig, postsInPeriod: 0 }, "2026-09-06");
    const today = rows.find((r) => r.date === "2026-09-06")!;
    assert.equal(today.videoViews, 0);
    assert.equal(today.engagements, 0);
  });

  test("a series point in the future is ignored", () => {
    const future = a.mapChannelAnalytics("instagram", { ...PAYLOAD.instagram, reach_timeseries: [{ date: "2026-09-06", value: 1 }, { date: "2026-09-09", value: 99 }] });
    const rows = s.planSocialRows(conn, [], { analytics: future, postsInPeriod: 0 }, "2026-09-06");
    assert.deepEqual(rows.map((r) => r.date), ["2026-09-06"]);
  });
});

describe("syncSocialStats", () => {
  function stage() {
    resetToBootstrap();
    const brandId = read().brands[0].id;
    const now = new Date().toISOString();
    const row = { brandId, status: "connected" as const, scopes: ["upload-post"], avatarColor: "#000", followers: 0, connectedAt: now };
    mutate((d) => {
      d.connections = d.connections.filter((c) => c.brandId !== brandId);
      d.dailyStats = [];
      d.connections.push(
        { ...row, id: "con_ig", channel: "instagram", handle: "@villa", externalId: "uploadpost:default:instagram" },
        { ...row, id: "con_li", channel: "linkedin", handle: "Villa", externalId: "uploadpost:default:linkedin" },
        { ...row, id: "con_fb", channel: "facebook", handle: "Villa", externalId: "uploadpost:default:facebook" },
      );
    });
    return brandId;
  }

  test("writes rows and the follower level; unsupported networks are skips with the connector's message", async () => {
    stage();
    const db = read();
    const igConn = db.connections.find((c) => c.id === "con_ig")!;
    const out = await s.syncSocialStats(igConn, async () => ({ analytics: ig, postsInPeriod: 1 }));
    assert.equal(out.ok, true);
    assert.equal(out.stats?.reach, 104);
    const rows = read().dailyStats.filter((r) => r.connectionId === "con_ig");
    assert.ok(rows.length >= 3, "one row per series day plus today");
    assert.ok(read().connections.find((c) => c.id === "con_ig")?.lastSyncedAt, "stamped");

    const li = await s.syncSocialStats(db.connections.find((c) => c.id === "con_li")!, async () => ({ analytics: a.mapChannelAnalytics("linkedin", PAYLOAD.linkedin), postsInPeriod: 0 }));
    assert.equal(li.ok, false);
    assert.equal(li.skipped, true);
    assert.match(li.detail ?? "", /personal profiles/);

    const fb = await s.syncSocialStats(db.connections.find((c) => c.id === "con_fb")!, async () => ({ analytics: a.mapChannelAnalytics("facebook", PAYLOAD.facebook), postsInPeriod: 0 }));
    assert.equal(fb.skipped, true);
    assert.equal(read().dailyStats.some((r) => r.connectionId === "con_fb"), false, "a skip writes nothing");
  });

  test("retrieveAll reports the connector-backed channels through the same seam", async () => {
    const brandId = stage();
    const { retrieveAll } = require("../src/lib/engine/sync") as typeof import("../src/lib/engine/sync");
    const res = await retrieveAll(brandId, {
      youtube: async () => null,
      social: async (channel) => ({ analytics: a.mapChannelAnalytics(channel, (PAYLOAD as Record<string, unknown>)[channel]), postsInPeriod: 1 }),
    });
    const by = (ch: string) => res.sources.find((x) => x.channel === ch)!;
    assert.equal(by("instagram").status, "synced");
    assert.equal(by("instagram").stats?.reach, 104);
    assert.equal(by("linkedin").status, "skipped");
    assert.equal(by("facebook").status, "skipped");
    assert.match(by("facebook").detail ?? "", /page_id/);
  });
});
