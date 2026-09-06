import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Load .env.local if present, mirroring tests/sheets.test.ts
const envPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const yt = require("../src/lib/youtube/public") as typeof import("../src/lib/youtube/public");

/* Payloads captured from the real API on 2026-09-05 (trimmed to the fields we read). */
const channelPayload = {
  items: [{
    id: "UCDjreja_dapcIneC5x56Tjg",
    snippet: { title: "Kiwik One", customUrl: "@kiwik-one", thumbnails: { default: { url: "https://yt3/default" }, high: { url: "https://yt3/high" } } },
    contentDetails: { relatedPlaylists: { likes: "", uploads: "UUDjreja_dapcIneC5x56Tjg" } },
    statistics: { viewCount: "0", subscriberCount: "12", hiddenSubscriberCount: false, videoCount: "1" },
  }],
};
const playlistPayload = { items: [{ contentDetails: { videoId: "eVcGxeyY9lY", videoPublishedAt: "2026-09-05T20:25:51Z" } }] };
const videosPayload = {
  items: [{
    id: "eVcGxeyY9lY",
    snippet: { title: "Logo assembling", publishedAt: "2026-09-05T20:25:51Z", thumbnails: { default: { url: "https://i.ytimg.com/vi/eVcGxeyY9lY/default.jpg" }, maxres: { url: "https://i.ytimg.com/vi/eVcGxeyY9lY/maxresdefault.jpg" } } },
    contentDetails: { duration: "PT8S" },
    statistics: { viewCount: "2", likeCount: "0", favoriteCount: "0", commentCount: "0" },
  }],
};
const commentsPayload = {
  items: [{
    id: "Ugzge340dBgB75hWBm54AaABAg",
    snippet: {
      topLevelComment: { snippet: { textDisplay: "can confirm: he never gave us up", textOriginal: "can confirm: he never gave us up", authorDisplayName: "@YouTube", authorProfileImageUrl: "https://yt3/avatar", likeCount: 311763, publishedAt: "2025-04-22T19:05:08Z" } },
      totalReplyCount: 1000,
    },
  }],
};

/** Stub global fetch with a router keyed on the API path. */
function stubFetch(handler: (url: URL) => { status?: number; body: unknown }) {
  const orig = globalThis.fetch;
  const calls: URL[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    const r = handler(url);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

describe("YouTube public API mapping", () => {
  test("parseDuration handles ISO-8601 variants", () => {
    assert.equal(yt.parseDuration("PT8S"), 8);
    assert.equal(yt.parseDuration("PT1H2M3S"), 3723);
    assert.equal(yt.parseDuration("PT12M"), 720);
    assert.equal(yt.parseDuration("P1DT1S"), 86401);
    assert.equal(yt.parseDuration(undefined), 0);
    assert.equal(yt.parseDuration("garbage"), 0);
  });

  test("mapChannel reads id, uploads playlist and numeric stats", () => {
    const c = yt.mapChannel(channelPayload)!;
    assert.equal(c.channelId, "UCDjreja_dapcIneC5x56Tjg");
    assert.equal(c.title, "Kiwik One");
    assert.equal(c.handle, "@kiwik-one");
    assert.equal(c.uploadsPlaylistId, "UUDjreja_dapcIneC5x56Tjg");
    assert.equal(c.thumbnail, "https://yt3/high");
    assert.deepEqual(c.stats, { views: 0, subscribers: 12, videos: 1, hiddenSubscriberCount: false });
    assert.equal(yt.mapChannel({ items: [] }), null);
    assert.equal(yt.mapChannel({}), null);
  });

  test("mapVideos picks the largest thumbnail and parses counts", () => {
    const [v] = yt.mapVideos(videosPayload);
    assert.equal(v.id, "eVcGxeyY9lY");
    assert.equal(v.title, "Logo assembling");
    assert.equal(v.thumbnail, "https://i.ytimg.com/vi/eVcGxeyY9lY/maxresdefault.jpg");
    assert.equal(v.duration, 8);
    assert.equal(v.views, 2);
    assert.equal(v.likes, 0);
    assert.equal(v.comments, 0);
    assert.equal(v.url, "https://www.youtube.com/watch?v=eVcGxeyY9lY");
    // commentCount is missing when comments are disabled — must not be NaN.
    const [w] = yt.mapVideos({ items: [{ id: "x", statistics: { viewCount: "5" } }] });
    assert.equal(w.comments, 0);
    assert.equal(w.likes, 0);
  });

  test("mapComments flattens top-level comment threads", () => {
    const [t] = yt.mapComments(commentsPayload);
    assert.deepEqual(t, {
      id: "Ugzge340dBgB75hWBm54AaABAg",
      author: "@YouTube",
      authorAvatar: "https://yt3/avatar",
      text: "can confirm: he never gave us up",
      likeCount: 311763,
      publishedAt: "2025-04-22T19:05:08Z",
      replies: 1000,
    });
    assert.deepEqual(yt.mapComments({}), []);
  });
});

describe("YouTube client with stubbed transport", () => {
  const prevYt = process.env.YOUTUBE_API_KEY;
  const prevSheets = process.env.GOOGLE_SHEETS_API_KEY;
  const restoreEnv = () => {
    if (prevYt === undefined) delete process.env.YOUTUBE_API_KEY; else process.env.YOUTUBE_API_KEY = prevYt;
    if (prevSheets === undefined) delete process.env.GOOGLE_SHEETS_API_KEY; else process.env.GOOGLE_SHEETS_API_KEY = prevSheets;
  };

  test("key resolution prefers YOUTUBE_API_KEY then falls back to GOOGLE_SHEETS_API_KEY", () => {
    try {
      delete process.env.YOUTUBE_API_KEY;
      delete process.env.GOOGLE_SHEETS_API_KEY;
      assert.equal(yt.isYouTubeConfigured(), false);
      process.env.GOOGLE_SHEETS_API_KEY = "sheets-key";
      assert.equal(yt.youtubeApiKey(), "sheets-key");
      process.env.YOUTUBE_API_KEY = "yt-key";
      assert.equal(yt.youtubeApiKey(), "yt-key");
    } finally { restoreEnv(); }
  });

  test("fetchYouTubeSnapshot returns null without a key and never throws", async () => {
    try {
      delete process.env.YOUTUBE_API_KEY;
      delete process.env.GOOGLE_SHEETS_API_KEY;
      assert.equal(await yt.fetchYouTubeSnapshot("@kiwik-one"), null);
      const r = await yt.fetchYouTubeSnapshotResult("@kiwik-one");
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "not_configured");
    } finally { restoreEnv(); }
  });

  test("fetchYouTubeSnapshot chains channels → playlistItems → videos and strips the @", async () => {
    process.env.YOUTUBE_API_KEY = "test-key";
    yt.clearYouTubeCache();
    const f = stubFetch((url) => {
      if (url.pathname.endsWith("/channels")) return { body: channelPayload };
      if (url.pathname.endsWith("/playlistItems")) return { body: playlistPayload };
      if (url.pathname.endsWith("/videos")) return { body: videosPayload };
      return { status: 404, body: {} };
    });
    try {
      const snap = await yt.fetchYouTubeSnapshot("@kiwik-one");
      assert.ok(snap);
      assert.equal(snap!.channel.channelId, "UCDjreja_dapcIneC5x56Tjg");
      assert.equal(snap!.videos.length, 1);
      assert.equal(snap!.videos[0].views, 2);
      assert.equal(f.calls[0].searchParams.get("forHandle"), "kiwik-one");
      assert.equal(f.calls[0].searchParams.get("key"), "test-key");
      assert.equal(f.calls[1].searchParams.get("playlistId"), "UUDjreja_dapcIneC5x56Tjg");
      assert.equal(f.calls[2].searchParams.get("id"), "eVcGxeyY9lY");
      assert.equal(f.calls.length, 3);

      // Second read within 5 minutes is served from cache: no new fetch.
      await yt.fetchYouTubeSnapshot("@kiwik-one");
      assert.equal(f.calls.length, 3);
    } finally { f.restore(); restoreEnv(); yt.clearYouTubeCache(); }
  });

  test("unknown handle → not_found; quotaExceeded → quota_exceeded; commentsDisabled → comments_disabled", async () => {
    process.env.YOUTUBE_API_KEY = "test-key";
    yt.clearYouTubeCache();
    const f = stubFetch((url) => {
      if (url.searchParams.get("forHandle") === "nobody") return { body: { items: [] } };
      if (url.searchParams.get("forHandle") === "quota") return { status: 403, body: { error: { code: 403, message: "quota", errors: [{ reason: "quotaExceeded" }] } } };
      if (url.pathname.endsWith("/commentThreads")) return { status: 403, body: { error: { errors: [{ reason: "commentsDisabled" }] } } };
      return { status: 500, body: {} };
    });
    try {
      const a = await yt.fetchYouTubeSnapshotResult("@nobody");
      assert.equal(a.ok, false); if (!a.ok) assert.equal(a.code, "not_found");
      assert.equal(await yt.fetchYouTubeSnapshot("@nobody"), null);
      const b = await yt.fetchYouTubeSnapshotResult("quota");
      assert.equal(b.ok, false); if (!b.ok) assert.equal(b.code, "quota_exceeded");
      const c = await yt.fetchYouTubeComments("eVcGxeyY9lY");
      assert.equal(c.ok, false); if (!c.ok) assert.equal(c.code, "comments_disabled");
      // Errors are not cached: the same handle is re-queried.
      await yt.fetchYouTubeSnapshotResult("quota");
      assert.equal(f.calls.filter((u) => u.searchParams.get("forHandle") === "quota").length, 2);
    } finally { f.restore(); restoreEnv(); yt.clearYouTubeCache(); }
  });

  test("empty channel: videoCount 0 short-circuits the playlist call and yields []", async () => {
    process.env.YOUTUBE_API_KEY = "test-key";
    yt.clearYouTubeCache();
    const empty = { items: [{ ...channelPayload.items[0], statistics: { ...channelPayload.items[0].statistics, videoCount: "0" } }] };
    const f = stubFetch((url) => {
      if (url.pathname.endsWith("/channels")) return { body: empty };
      return { status: 500, body: {} };
    });
    try {
      const r = await yt.fetchYouTubeSnapshotResult("@kiwik-one");
      assert.equal(r.ok, true);
      if (r.ok) { assert.deepEqual(r.snapshot.videos, []); assert.equal(r.snapshot.channel.stats.subscribers, 12); }
      assert.equal(f.calls.some((u) => u.pathname.endsWith("/playlistItems")), false);
    } finally { f.restore(); restoreEnv(); yt.clearYouTubeCache(); }
  });

  test("playlistNotFound on the uploads playlist is an empty list, not an error; other 404s still surface tag-free", async () => {
    process.env.YOUTUBE_API_KEY = "test-key";
    yt.clearYouTubeCache();
    // Real body shape from Google for a channel with no uploads playlist.
    const notFound = { error: { code: 404, message: "The playlist identified with the request's <code>playlistId</code> parameter cannot be found.", errors: [{ reason: "playlistNotFound" }] } };
    const f = stubFetch((url) => {
      if (url.pathname.endsWith("/channels")) return { body: channelPayload }; // videoCount "1" so the playlist is queried
      if (url.pathname.endsWith("/playlistItems")) return { status: 404, body: notFound };
      return { status: 500, body: {} };
    });
    try {
      const r = await yt.fetchYouTubeSnapshotResult("@kiwik-one");
      assert.equal(r.ok, true);
      if (r.ok) assert.deepEqual(r.snapshot.videos, []);
      assert.notEqual(await yt.fetchYouTubeSnapshot("@kiwik-one"), null);
    } finally { f.restore(); yt.clearYouTubeCache(); }
    // A 404 with a different reason still fails, with Google's markup stripped from the message.
    const other = stubFetch((url) => {
      if (url.pathname.endsWith("/channels")) return { body: channelPayload };
      return { status: 404, body: { error: { message: "Bad <code>thing</code>.", errors: [{ reason: "videoNotFound" }] } } };
    });
    try {
      const r = await yt.fetchYouTubeSnapshotResult("@kiwik-one");
      assert.equal(r.ok, false);
      if (!r.ok) { assert.equal(r.code, "not_found"); assert.equal(r.error, "Bad thing."); }
    } finally { other.restore(); restoreEnv(); yt.clearYouTubeCache(); }
  });
});

describe("YouTube live API verification", () => {
  test("resolves @kiwik-one and lists its uploads", async (t) => {
    if (!process.env.YOUTUBE_API_KEY && !process.env.GOOGLE_SHEETS_API_KEY) {
      t.skip("YOUTUBE_API_KEY / GOOGLE_SHEETS_API_KEY not configured in environment");
      return;
    }
    yt.clearYouTubeCache();
    const r = await yt.fetchYouTubeSnapshotResult("@kiwik-one");
    if (!r.ok && r.code === "quota_exceeded") { t.skip("YouTube quota exhausted"); return; }
    assert.equal(r.ok, true, r.ok ? "" : r.error);
    if (!r.ok) return;
    assert.equal(r.snapshot.channel.channelId, "UCDjreja_dapcIneC5x56Tjg");
    assert.ok(r.snapshot.channel.uploadsPlaylistId.startsWith("UU"));
    for (const v of r.snapshot.videos) {
      assert.match(v.id, /^[\w-]{11}$/);
      assert.ok(Number.isFinite(v.views) && Number.isFinite(v.likes) && Number.isFinite(v.comments));
      assert.ok(v.duration >= 0);
    }
  });
});

describe("youtubeChannelRef", () => {
  test("prefers the UC… channel id over a display-name handle (native OAuth rows)", () => {
    // exchange.ts stores the channel title in `handle`; forHandle= can't resolve it.
    assert.equal(yt.youtubeChannelRef({ externalId: "UCa1b2c3d4e5f6g7h8i9j0k1l", handle: "Kiwik One" }), "UCa1b2c3d4e5f6g7h8i9j0k1l");
  });

  test("falls back to the handle for Upload-Post rows", () => {
    assert.equal(yt.youtubeChannelRef({ externalId: "uploadpost:kiwik:youtube", handle: "@kiwik-one" }), "@kiwik-one");
    assert.equal(yt.youtubeChannelRef({ externalId: null, handle: "@kiwik-one" }), "@kiwik-one");
  });
});

/* ------------------------------------------------------------------ */
/* Studio panel helpers (src/lib/youtube/studio.ts)                     */
/* ------------------------------------------------------------------ */

const studio = require("../src/lib/youtube/studio") as typeof import("../src/lib/youtube/studio");

describe("YouTube studio totals", () => {
  const vids = [
    { id: "a", title: "A", url: "u/a", views: 100, likes: 10, comments: 5 },
    { id: "b", title: "B", url: "u/b", views: 300, likes: 0, comments: 15 },
    { id: "c", title: "C", url: "u/c", views: 0, likes: 0, comments: 0 },
  ];

  test("computeTotals sums counts and derives avg views + engagement rate", () => {
    const t = studio.computeTotals(vids);
    assert.deepEqual(t, { views: 400, likes: 10, comments: 20, uploads: 3, avgViews: 400 / 3, engagementRate: 30 / 400 });
    // No uploads / no views must not divide by zero.
    assert.deepEqual(studio.computeTotals([]), { views: 0, likes: 0, comments: 0, uploads: 0, avgViews: 0, engagementRate: 0 });
    assert.equal(studio.computeTotals([{ views: 0, likes: 3, comments: 1 }]).engagementRate, 0);
  });

  test("rankByViews is 1-based and stable for ties", () => {
    assert.equal(studio.rankByViews(vids, "b"), 1);
    assert.equal(studio.rankByViews(vids, "a"), 2);
    assert.equal(studio.rankByViews(vids, "c"), 3);
    assert.equal(studio.rankByViews(vids, "zzz"), 0);
    assert.equal(studio.rankByViews([{ id: "x", views: 5 }, { id: "y", views: 5 }], "x"), 1);
  });

  test("performancePct centres the channel average at 50 and caps at 2×", () => {
    assert.equal(studio.performancePct(100, 100), 50);
    assert.equal(studio.performancePct(50, 100), 25);
    assert.equal(studio.performancePct(1000, 100), 100);
    assert.equal(studio.performancePct(0, 100), 0);
    assert.equal(studio.performancePct(0, 0), 0);
    assert.equal(studio.performancePct(7, 0), 100);
  });
});

describe("YouTube recent-comments mapping", () => {
  const thread = (id: string, publishedAt: string) => ({ id, author: "x", text: id, likeCount: 0, publishedAt, replies: 2 });

  test("mergeRecentComments flattens per-video threads newest-first and tags the video", () => {
    const out = studio.mergeRecentComments([
      { video: { id: "v1", title: "One", url: "u/1" }, threads: [thread("old", "2026-01-01T00:00:00Z"), thread("newest", "2026-03-01T00:00:00Z")] },
      { video: { id: "v2", title: "Two", url: "u/2" }, threads: [thread("mid", "2026-02-01T00:00:00Z")] },
    ]);
    assert.deepEqual(out.map((c) => c.id), ["newest", "mid", "old"]);
    assert.equal(out[1].videoId, "v2");
    assert.equal(out[1].videoTitle, "Two");
    assert.equal(out[1].videoUrl, "u/2");
    assert.equal(out[0].replies, 2);
    assert.equal(studio.mergeRecentComments([], 5).length, 0);
    assert.equal(studio.mergeRecentComments([{ video: { id: "v", title: "", url: "" }, threads: [thread("a", "1"), thread("b", "2")] }], 1).length, 1);
  });

  test("fetchYouTubeRecentComments spends one unit per commented video and tolerates disabled comments", async () => {
    process.env.YOUTUBE_API_KEY = "test-key";
    yt.clearYouTubeCache();
    const f = stubFetch((url) => {
      if (!url.pathname.endsWith("/commentThreads")) return { status: 500, body: {} };
      if (url.searchParams.get("videoId") === "disabled0000") return { status: 403, body: { error: { errors: [{ reason: "commentsDisabled" }] } } };
      return { body: commentsPayload };
    });
    try {
      const videos = [
        { id: "eVcGxeyY9lY", title: "Logo", url: "u/1", comments: 3 },
        { id: "nocomments0", title: "Quiet", url: "u/2", comments: 0 }, // skipped: nothing to read
        { id: "disabled0000", title: "Off", url: "u/3", comments: 1 },
      ];
      const r = await yt.fetchYouTubeRecentComments(videos, 10, 10);
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.comments.length, 1);
      assert.equal(r.comments[0].videoId, "eVcGxeyY9lY");
      assert.equal(r.comments[0].videoTitle, "Logo");
      const called = f.calls.map((u) => u.searchParams.get("videoId"));
      assert.deepEqual(called.sort(), ["disabled0000", "eVcGxeyY9lY"]);
      assert.equal(f.calls[0].searchParams.get("order"), "time");
      // Second read inside the 2-minute window is served from cache.
      await yt.fetchYouTubeRecentComments(videos, 10, 10);
      assert.equal(f.calls.filter((u) => u.searchParams.get("videoId") === "eVcGxeyY9lY").length, 1);
      // videoCount caps the fan-out.
      await yt.fetchYouTubeRecentComments([{ id: "aaaaaaaaaaa", title: "", url: "", comments: 1 }, { id: "bbbbbbbbbbb", title: "", url: "", comments: 1 }], 1, 10);
      assert.equal(f.calls.some((u) => u.searchParams.get("videoId") === "bbbbbbbbbbb"), false);
    } finally { f.restore(); restoreEnvKeys(); yt.clearYouTubeCache(); }
  });
});

describe("YouTube fresh-bypass throttle", () => {
  test("FreshBypassThrottle allows one bypass per key per window", () => {
    let now = 1_000_000;
    const t = new studio.FreshBypassThrottle(20_000, () => now);
    assert.equal(t.allow("brand-a"), true);
    assert.equal(t.allow("brand-a"), false);
    assert.equal(t.retryAfter("brand-a"), 20);
    // Other brands are independent.
    assert.equal(t.allow("brand-b"), true);
    now += 19_999;
    assert.equal(t.allow("brand-a"), false);
    assert.equal(t.retryAfter("brand-a"), 1);
    now += 1;
    assert.equal(t.retryAfter("brand-a"), 0);
    assert.equal(t.allow("brand-a"), true);
    assert.equal(t.retryAfter("never"), 0);
  });

  test("fresh:true skips the read cache but still refills it", async () => {
    process.env.YOUTUBE_API_KEY = "test-key";
    yt.clearYouTubeCache();
    const f = stubFetch((url) => {
      if (url.pathname.endsWith("/channels")) return { body: channelPayload };
      if (url.pathname.endsWith("/playlistItems")) return { body: playlistPayload };
      if (url.pathname.endsWith("/videos")) return { body: videosPayload };
      return { status: 404, body: {} };
    });
    try {
      await yt.fetchYouTubeSnapshotResult("@kiwik-one");
      assert.equal(f.calls.length, 3);
      await yt.fetchYouTubeSnapshotResult("@kiwik-one");
      assert.equal(f.calls.length, 3, "cached");
      await yt.fetchYouTubeSnapshotResult("@kiwik-one", { fresh: true });
      assert.equal(f.calls.length, 6, "fresh re-reads every hop");
      await yt.fetchYouTubeSnapshotResult("@kiwik-one");
      assert.equal(f.calls.length, 6, "fresh read warmed the cache for the next poll");
    } finally { f.restore(); restoreEnvKeys(); yt.clearYouTubeCache(); }
  });

  test("videos route rate-limits ?fresh=1 per brand and feeds syncYouTubeStats; recent-comments route is guarded", () => {
    const videos = fs.readFileSync(path.resolve(process.cwd(), "src/app/api/channels/youtube/videos/route.ts"), "utf8");
    assert.match(videos, /new FreshBypassThrottle\(20_000\)/);
    assert.match(videos, /freshThrottle\.allow\(throttleKey\)/);
    assert.match(videos, /fetchYouTubeSnapshotResult\(youtubeChannelRef\(conn\), \{ fresh \}\)/);
    assert.match(videos, /syncYouTubeStats\(conn, async \(\) => snapshot\)/);
    const recent = fs.readFileSync(path.resolve(process.cwd(), "src/app/api/channels/youtube/recent-comments/route.ts"), "utf8");
    assert.match(recent, /guard\("analytics\.view"\)/);
    assert.match(recent, /fetchYouTubeRecentComments\(snap\.snapshot\.videos, 10, 10\)/);
  });
});

/** Env restore shared by the suites appended above (the earlier one is scoped to its describe). */
const origYtKey = process.env.YOUTUBE_API_KEY;
function restoreEnvKeys() {
  if (origYtKey === undefined) delete process.env.YOUTUBE_API_KEY; else process.env.YOUTUBE_API_KEY = origYtKey;
}
