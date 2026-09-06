import assert from "node:assert/strict";
import test, { after, describe } from "node:test";
import { cleanup, isolate } from "./helpers";
import type { DailyStat } from "../src/lib/types";

/**
 * The YouTube block on /analytics is built from two sources — per-day
 * dailyStats deltas and the live snapshot — and a freshness rule that decides
 * when the page re-syncs. All three are pure, so they are pinned here with
 * fixtures rather than through a page render.
 */
const dir = isolate("metrics-youtube");
process.env.UPLOAD_POST_API_KEY = "test-key";
after(() => cleanup(dir));

const m = require("../src/lib/metrics/youtube") as typeof import("../src/lib/metrics/youtube");
const fr = require("../src/lib/engine/freshness") as typeof import("../src/lib/engine/freshness");
const { read, mutate, resetToBootstrap } = require("../src/lib/db") as typeof import("../src/lib/db");

const row = (date: string, o: Partial<DailyStat> = {}): DailyStat => ({
  brandId: "b1", connectionId: "con_yt", channel: "youtube", date,
  followers: 100, followerDelta: 0, impressions: 0, reach: 0, engagements: 0,
  profileVisits: 0, linkClicks: 0, posts: 0, storyViews: 0, videoViews: 0, ...o,
});

const range = { from: "2026-09-01", to: "2026-09-05" };

describe("youtubeRangeRollup", () => {
  test("sums per-day movement and takes the newest subscriber level", () => {
    const stats = [
      row("2026-08-31", { followers: 90, followerDelta: 5, videoViews: 999 }), // outside range
      row("2026-09-01", { followers: 100, followerDelta: 10, videoViews: 40, engagements: 4, posts: 1 }),
      row("2026-09-03", { followers: 130, followerDelta: 30, videoViews: 60, engagements: 6, posts: 0 }),
      { ...row("2026-09-03", { followers: 20, followerDelta: 2 }), connectionId: "con_yt2" },
      row("2026-09-02", { channel: "instagram", followers: 5000, videoViews: 1 }),
    ];
    const r = m.youtubeRangeRollup(stats, range);
    assert.equal(r.subscribers, 150, "newest day, summed across connections");
    assert.equal(r.subscriberDelta, 42);
    assert.equal(r.views, 100);
    assert.equal(r.engagements, 10);
    assert.equal(r.uploads, 1);
    assert.equal(r.days, 2);
  });

  test("empty range is all zeros, not NaN", () => {
    assert.deepEqual(m.youtubeRangeRollup([], range), { subscribers: 0, subscriberDelta: 0, views: 0, engagements: 0, uploads: 0, days: 0 });
  });

  test("youtubeSeries is oldest-first and ignores other channels", () => {
    const s = m.youtubeSeries([
      row("2026-09-03", { videoViews: 3 }),
      row("2026-09-01", { videoViews: 1 }),
      row("2026-09-02", { channel: "facebook", videoViews: 50 }),
    ], range);
    assert.deepEqual(s.map((p) => [p.date, p.views]), [["2026-09-01", 1], ["2026-09-03", 3]]);
  });
});

const vids = [
  { id: "a", title: "A", publishedAt: "2026-09-02T10:00:00Z", views: 50, likes: 5, comments: 1, url: "u/a" },
  { id: "b", title: "B", publishedAt: "2026-08-01T10:00:00Z", views: 500, likes: 20, comments: 10, url: "u/b" },
  { id: "c", title: "C", publishedAt: "2026-09-05T23:59:00Z", views: 500, likes: 30, comments: 0, url: "u/c" },
  { id: "d", title: "D", publishedAt: "", views: 10, likes: 0, comments: 0, url: "u/d" },
  { id: "e", title: "E", publishedAt: "2026-07-01T00:00:00Z", views: 5, likes: 1, comments: 1, url: "u/e" },
  { id: "f", title: "F", publishedAt: "2026-07-02T00:00:00Z", views: 1, likes: 0, comments: 0, url: "u/f" },
];

describe("snapshot helpers", () => {
  test("topVideos ranks by views, likes break ties, capped at n", () => {
    const top = m.topVideos(vids, 5);
    assert.deepEqual(top.map((v) => v.id), ["c", "b", "a", "d", "e"]);
    assert.equal(m.topVideos(vids, 2).length, 2);
    assert.equal(vids[0].id, "a", "input is not reordered");
  });

  test("uploadsInRange uses the UTC publish day and skips blank dates", () => {
    assert.deepEqual(m.uploadsInRange(vids, range).map((v) => v.id), ["a", "c"]);
  });

  test("engagementComposition shares sum to 100 and survive zero", () => {
    const mix = m.engagementComposition(vids);
    assert.equal(mix.likes, 56);
    assert.equal(mix.comments, 12);
    assert.equal(mix.total, 68);
    assert.ok(Math.abs(mix.likeShare + mix.commentShare - 100) < 1e-9);
    assert.deepEqual(m.engagementComposition([]), { likes: 0, comments: 0, total: 0, likeShare: 0, commentShare: 0 });
  });

  test("snapshotTotals sums views/likes/comments", () => {
    assert.deepEqual(m.snapshotTotals(vids), { views: 1066, likes: 56, comments: 12 });
  });
});

describe("freshness decision", () => {
  const now = new Date("2026-09-05T12:00:00Z");
  test("fresh stamp inside ten minutes is not stale", () => {
    assert.equal(m.isStale({ lastSyncedAt: "2026-09-05T11:51:00Z" }, now), false);
  });
  test("stamp older than ten minutes is stale", () => {
    assert.equal(m.isStale({ lastSyncedAt: "2026-09-05T11:49:59Z" }, now), true);
  });
  test("no stamp: today's row counts as fresh, an older row does not", () => {
    assert.equal(m.isStale({ newestStatDate: "2026-09-05" }, now), false);
    assert.equal(m.isStale({ newestStatDate: "2026-09-04" }, now), true);
    assert.equal(m.isStale({}, now), true);
  });
  test("an old stamp is not rescued by today's row", () => {
    assert.equal(m.isStale({ lastSyncedAt: "2026-09-05T08:00:00Z", newestStatDate: "2026-09-05" }, now), true);
  });
  test("updatedAgo wording", () => {
    assert.equal(m.updatedAgo(null, now), "never");
    assert.equal(m.updatedAgo("2026-09-05T11:59:40Z", now), "just now");
    assert.equal(m.updatedAgo("2026-09-05T11:56:00Z", now), "4 min ago");
    assert.equal(m.updatedAgo("2026-09-05T09:00:00Z", now), "3 h ago");
    assert.equal(m.updatedAgo("2026-09-03T09:00:00Z", now), "2 d ago");
  });
});

describe("ensureFreshStats", () => {
  function stage(lastSyncedAt?: string): string {
    resetToBootstrap();
    const brandId = read().brands[0].id;
    mutate((d) => {
      d.connections = d.connections.filter((c) => c.brandId !== brandId);
      d.dailyStats = [];
      d.activity = [];
      d.connections.push({
        id: "con_yt", brandId, channel: "youtube", handle: "@villa-yt", externalId: "uploadpost:default:youtube",
        status: "connected", scopes: [], avatarColor: "#000", followers: 0, connectedAt: "2026-01-01T00:00:00Z", lastSyncedAt,
      });
    });
    return brandId;
  }

  test("reads the brand's newest YouTube stamp and stat day", () => {
    const brandId = stage("2026-09-01T00:00:00Z");
    mutate((d) => d.dailyStats.push(row("2026-08-30", { brandId }), row("2026-09-01", { brandId })));
    const input = fr.youtubeFreshnessInput(read(), brandId);
    assert.deepEqual(input, { lastSyncedAt: "2026-09-01T00:00:00Z", newestStatDate: "2026-09-01", connected: true });
  });

  test("a fresh stamp skips the sync; a stale one runs it and swallows failure", async () => {
    const brandId = stage(new Date().toISOString());
    const skip = await fr.ensureFreshStats(brandId);
    assert.equal(skip.refreshed, false);

    // No API key in tests: the YouTube fetch reports an error, the sync
    // records it per-source, and the page still gets an answer.
    delete process.env.YOUTUBE_API_KEY;
    delete process.env.GOOGLE_SHEETS_API_KEY;
    const stale = stage("2026-01-01T00:00:00Z");
    fr.resetFreshnessBackoff();
    const out = await fr.ensureFreshStats(stale);
    assert.equal(out.refreshed, false, "nothing reached 'synced', so there is nothing to re-read");
    assert.equal(out.lastSyncedAt, "2026-01-01T00:00:00Z", "a failed source keeps its old stamp");
    assert.equal(read().activity.length, 0, "background refresh does not post to the activity feed");
  });

  test("a failed attempt is not retried within the TTL", async () => {
    delete process.env.YOUTUBE_API_KEY;
    delete process.env.GOOGLE_SHEETS_API_KEY;
    const brandId = stage("2026-01-01T00:00:00Z");
    fr.resetFreshnessBackoff();
    let calls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => { calls += 1; throw new Error("quota"); }) as typeof fetch;
    try {
      process.env.YOUTUBE_API_KEY = "test-key";
      await fr.ensureFreshStats(brandId);
      await fr.ensureFreshStats(brandId);
      await fr.ensureFreshStats(brandId);
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.YOUTUBE_API_KEY;
      fr.resetFreshnessBackoff();
    }
    assert.ok(calls <= 1, `expected at most one upstream call, got ${calls}`);
  });

  test("a hung YouTube API does not hold the page past the deadline", async () => {
    process.env.YOUTUBE_API_KEY = "test-key";
    const brandId = stage("2026-01-01T00:00:00Z");
    fr.resetFreshnessBackoff();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch; // never resolves
    const started = Date.now();
    try {
      const out = await fr.ensureFreshStats(brandId);
      assert.equal(out.refreshed, false, "stale rows are rendered when the refresh loses the race");
      assert.equal(out.lastSyncedAt, "2026-01-01T00:00:00Z");
      assert.ok(Date.now() - started < fr.REFRESH_DEADLINE_MS + 1500, "returns right after the deadline");
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.YOUTUBE_API_KEY;
      fr.resetFreshnessBackoff();
    }
  });

  test("no YouTube connection: nothing to refresh", async () => {
    resetToBootstrap();
    const brandId = read().brands[0].id;
    mutate((d) => { d.connections = d.connections.filter((c) => c.brandId !== brandId); });
    assert.deepEqual(await fr.ensureFreshStats(brandId), { lastSyncedAt: null, refreshed: false });
  });
});
