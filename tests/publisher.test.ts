import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { cleanup, isolate } from "./helpers";

/**
 * The publisher must never claim to have published.
 *
 * mockPublish() used to return a fabricated success — an invented external id
 * and permalink — whenever no live driver was configured. That propagated into
 * target state, the calendar and the analytics counts, so the product reported
 * posts as live that had never been sent anywhere. These two tests pin the
 * property that replaced it: with no live API, nothing is ever recorded as
 * published, and the failure is permanent rather than retried forever.
 */
const dir = isolate("publisher");
after(() => cleanup(dir));

const { read, mutate, resetToBootstrap } = require("../src/lib/db") as typeof import("../src/lib/db");
const { runTick } = require("../src/lib/engine/publisher") as typeof import("../src/lib/engine/publisher");

function stage(): string {
  resetToBootstrap();
  const brandId = read().brands[0].id;
  const now = new Date(Date.now() - 60_000).toISOString();
  mutate((d) => {
    d.connections.push({ id: "con_test", brandId, channel: "instagram", handle: "@test",
      externalId: "1784", status: "connected", accessToken: "tok", scopes: [],
      avatarColor: "#000", followers: 0, connectedAt: now });
    d.media.push({ id: "med_test", brandId, kind: "video", src: "/samples/a.mp4",
      width: 1080, height: 1920, renders: { "9:16": "/renders/abc.mp4" }, createdAt: now, tags: [] });
    d.posts.push({ id: "post_test", brandId, status: "scheduled", caption: "probe",
      hashtags: ["villa"], mediaIds: ["med_test"],
      targets: [{ connectionId: "con_test", channel: "instagram", format: "reel",
        status: "scheduled", attempts: 0 }],
      scheduledAt: now, autoScheduled: false, approvals: [],
      createdBy: "test", createdAt: now, updatedAt: now });
  });
  return brandId;
}

describe("publisher honesty", () => {
  test("mock driver never reports a fabricated publish", async () => {
    stage();
    const res = await runTick();
    const t = read().posts[0].targets[0];
    console.log("    tick:", JSON.stringify({ published: res.published, failed: res.failed, deferred: res.deferred }));
    console.log("    message:", res.details[0]?.message);
    console.log("    target :", JSON.stringify({ status: t.status, externalId: t.externalId ?? null, error: t.error }));
    assert.equal(res.published, 0, "nothing may be reported as published without a live API");
    assert.equal(t.externalId, undefined, "no fabricated external id may be recorded");
    assert.notEqual(t.status, "published", "target must not be marked published");
  });

  test("with media reachable, the mock driver still refuses to fake a publish", async () => {
    process.env.PUBLIC_BASE_URL = "https://example.test";
    stage();
    const res = await runTick();
    const t = read().posts[0].targets[0];
    console.log("    [2] tick:", JSON.stringify({ published: res.published, failed: res.failed }));
    console.log("    [2] error:", t.error);
    console.log("    [2] retryable(status):", t.status);
    delete process.env.PUBLIC_BASE_URL;
    assert.equal(res.published, 0, "mock driver must never report a publish");
    assert.equal(t.externalId, undefined, "no fabricated external id");
    assert.equal(t.status, "failed", "a non-live driver is a permanent failure, not an endless retry");
  });
});
