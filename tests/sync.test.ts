import assert from "node:assert/strict";
import test, { after, describe } from "node:test";
import { cleanup, isolate } from "./helpers";

/**
 * Retrieval must be honest about Upload-Post-backed connections.
 *
 * Those rows carry no access token — Upload-Post publishes for them but has no
 * read API — so the sync used to either throw on `accessToken!` or bury them in
 * a generic "not connected" line. It now reports each one as skipped with the
 * reason, and YouTube, whose stats are public, gets a dailyStats row for today
 * that the dashboards already know how to aggregate.
 */
const dir = isolate("sync");
process.env.UPLOAD_POST_API_KEY = "test-key"; // makes the Upload-Post rows "usable"
after(() => cleanup(dir));

const { read, mutate, resetToBootstrap } = require("../src/lib/db") as typeof import("../src/lib/db");
const { retrieveAll } = require("../src/lib/engine/sync") as typeof import("../src/lib/engine/sync");
const { rollupByChannel, lastNDays, statsFor } = require("../src/lib/metrics/aggregate") as typeof import("../src/lib/metrics/aggregate");

function stage(): string {
  resetToBootstrap();
  const brandId = read().brands[0].id;
  const now = new Date().toISOString();
  const row = { brandId, status: "connected" as const, scopes: ["upload-post"], avatarColor: "#000", followers: 0, connectedAt: now };
  mutate((d) => {
    d.connections = d.connections.filter((c) => c.brandId !== brandId);
    d.dailyStats = [];
    d.connections.push(
      { ...row, id: "con_ig", channel: "instagram", handle: "@villa", externalId: "uploadpost:default:instagram" },
      { ...row, id: "con_yt", channel: "youtube", handle: "@villa-yt", externalId: "uploadpost:default:youtube" },
    );
  });
  return brandId;
}

const snapshot = async () => ({
  channel: { channelId: "UC1", title: "Villa", stats: { views: 1000, subscribers: 250, videos: 2 } },
  videos: [
    { id: "v1", title: "Tour", publishedAt: "2026-01-01T00:00:00Z", views: 600, likes: 30, comments: 5 },
    { id: "v2", title: "Sunset", publishedAt: "2026-02-01T00:00:00Z", views: 400, likes: 10, comments: 5 },
  ],
});

/**
 * Connector analytics stub: the network is never touched here. It reports the
 * "cannot read this account" state so the Instagram row is a skip, which is
 * what the suite below pins.
 */
const social = async () => ({
  analytics: {
    channel: "instagram" as const, ok: false, reason: "page_id_required" as const,
    message: "Analytics for this account need a page id.",
    totals: { followers: 0, reach: 0, views: 0, impressions: 0, profileViews: 0, likes: 0, comments: 0, shares: 0, saves: 0 },
    reachSeries: [], impressionsSeries: [], availableMetrics: [], metricLabels: {}, periodDays: 30,
  },
  postsInPeriod: 0,
});

describe("retrieval sync", () => {
  test("Upload-Post-backed Instagram the connector cannot report on is skipped with a reason, not an error", async () => {
    const brandId = stage();
    const res = await retrieveAll(brandId, { youtube: async () => null, social });
    const ig = res.sources.find((s) => s.channel === "instagram");
    assert.ok(ig, "instagram must appear in the report");
    assert.equal(ig.status, "skipped");
    assert.equal(ig.error, undefined);
    assert.match(ig.detail ?? "", /page id/);
    assert.equal(res.ok, true);
    assert.equal(res.totals.skipped, 1);
    // A skipped source was not synced, so it must not be stamped as such.
    assert.equal(read().connections.find((c) => c.id === "con_ig")?.lastSyncedAt, undefined);
  });

  test("YouTube snapshot becomes today's dailyStats row and is idempotent", async () => {
    const brandId = stage();
    const today = new Date().toISOString().slice(0, 10);

    const first = await retrieveAll(brandId, { youtube: snapshot, social });
    const yt = first.sources.find((s) => s.channel === "youtube");
    assert.equal(yt?.status, "synced");
    assert.deepEqual(yt?.stats, { impressions: 1000, engagements: 50, posts: 2, followers: 250 });

    const rows = read().dailyStats.filter((s) => s.connectionId === "con_yt");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].date, today);
    assert.equal(rows[0].channel, "youtube");
    assert.equal(rows[0].impressions, 1000);
    assert.equal(rows[0].engagements, 50);
    assert.equal(rows[0].posts, 2);
    assert.equal(rows[0].followers, 250);
    assert.equal(read().connections.find((c) => c.id === "con_yt")?.followers, 250);

    // Same day again: refreshed in place, never duplicated.
    await retrieveAll(brandId, { youtube: snapshot, social });
    assert.equal(read().dailyStats.filter((s) => s.connectionId === "con_yt").length, 1);

    // And the dashboards' aggregate sees it.
    const rollup = rollupByChannel(statsFor(read(), brandId), lastNDays(30)).find((r) => r.channel === "youtube");
    assert.equal(rollup?.impressions, 1000);
    assert.equal(rollup?.followers, 250);
    assert.equal(rollup?.posts, 2);
  });

  test("YouTube rows hold per-day movement, so a multi-day rollup equals the channel's real totals", async () => {
    const brandId = stage();
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    // Yesterday's sync was the first ever: its row carries the lifetime figures.
    await retrieveAll(brandId, { youtube: snapshot, social });
    mutate((d) => {
      const row = d.dailyStats.find((s) => s.connectionId === "con_yt")!;
      row.date = yesterday;
    });

    // Today the channel is unchanged: the new row must book zero movement, not
    // a second copy of the lifetime numbers.
    await retrieveAll(brandId, { youtube: snapshot, social });
    const rows = read().dailyStats.filter((s) => s.connectionId === "con_yt").sort((a, b) => a.date.localeCompare(b.date));
    assert.deepEqual(rows.map((r) => r.date), [yesterday, today]);
    assert.equal(rows[1].impressions, 0);
    assert.equal(rows[1].engagements, 0);
    assert.equal(rows[1].posts, 0);
    assert.equal(rows[1].followerDelta, 0);

    let rollup = rollupByChannel(statsFor(read(), brandId), lastNDays(30)).find((r) => r.channel === "youtube");
    assert.equal(rollup?.impressions, 1000);
    assert.equal(rollup?.posts, 2);
    assert.equal(rollup?.engagements, 50);

    // Growth shows up as today's delta; a same-day re-run replaces it rather than stacking.
    const grown = async () => {
      const s = await snapshot();
      return { ...s, channel: { ...s.channel, stats: { ...s.channel.stats, subscribers: 260 } }, videos: [...s.videos, { id: "v3", title: "New", publishedAt: "2026-03-01T00:00:00Z", views: 150, likes: 7, comments: 3 }] };
    };
    await retrieveAll(brandId, { youtube: grown, social });
    await retrieveAll(brandId, { youtube: grown, social });
    const todayRow = read().dailyStats.find((s) => s.connectionId === "con_yt" && s.date === today)!;
    assert.equal(todayRow.impressions, 150);
    assert.equal(todayRow.engagements, 10);
    assert.equal(todayRow.posts, 1);
    assert.equal(todayRow.followerDelta, 10);
    rollup = rollupByChannel(statsFor(read(), brandId), lastNDays(30)).find((r) => r.channel === "youtube");
    assert.equal(rollup?.impressions, 1150);
    assert.equal(rollup?.posts, 3);
    assert.equal(rollup?.followers, 260);
  });

  test("YouTube with no snapshot is reported as an error for that source only", async () => {
    const brandId = stage();
    const res = await retrieveAll(brandId, { youtube: async () => null, social });
    const yt = res.sources.find((s) => s.channel === "youtube");
    assert.equal(yt?.status, "error");
    assert.match(yt?.error ?? "", /YouTube stats unavailable/);
    assert.equal(res.ok, true);
    assert.equal(read().dailyStats.length, 0);
  });
});
