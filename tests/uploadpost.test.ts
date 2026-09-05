import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Load .env.local if present
const envPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const {
  checkUploadPostStatus,
  isUploadPostConfigured,
  uploadPostApiKey,
  uploadPostUser,
} = require("../src/lib/uploadpost/client");

describe("Upload-Post client unit tests", () => {
  test("reports configured when API key is present", () => {
    const prev = process.env.UPLOAD_POST_API_KEY;
    try {
      delete process.env.UPLOAD_POST_API_KEY;
      assert.equal(isUploadPostConfigured(), false);

      process.env.UPLOAD_POST_API_KEY = "dummy-token";
      assert.equal(isUploadPostConfigured(), true);
      assert.equal(uploadPostApiKey(), "dummy-token");
    } finally {
      if (prev) process.env.UPLOAD_POST_API_KEY = prev;
    }
  });

  test("defaults user to default profile", () => {
    const prev = process.env.UPLOAD_POST_USER;
    try {
      delete process.env.UPLOAD_POST_USER;
      assert.equal(uploadPostUser(), "default");

      process.env.UPLOAD_POST_USER = "custom-user";
      assert.equal(uploadPostUser(), "custom-user");
    } finally {
      if (prev) process.env.UPLOAD_POST_USER = prev;
      else delete process.env.UPLOAD_POST_USER;
    }
  });
});

describe("Upload-Post live token & account verification", () => {
  test("authenticates token with upload-post.com and resolves social links", async (t) => {
    if (!process.env.UPLOAD_POST_API_KEY) {
      t.skip("UPLOAD_POST_API_KEY not configured in environment");
      return;
    }

    let status;
    try {
      status = await checkUploadPostStatus();
    } catch (e) {
      t.skip(`Network unreachable: ${(e as Error).message}`);
      return;
    }

    if (status.error?.includes("fetch failed") || status.error?.includes("ENOTFOUND")) {
      t.skip(`Network unreachable (sandboxed): ${status.error}`);
      return;
    }

    assert.equal(status.configured, true);
    assert.equal(status.valid, true, `Token rejected: ${status.error}`);
    assert.equal(status.email, "praneethreddy.kiwik@gmail.com");
    assert.ok(status.profiles.length > 0, "Profiles list should not be empty");

    assert.ok(status.connectedAccounts.instagram, "Instagram account should be connected");
    assert.equal(status.connectedAccounts.instagram?.handle, "kiwik.one1");

    assert.ok(status.connectedAccounts.youtube, "YouTube account should be connected");
    assert.equal(status.connectedAccounts.youtube?.handle, "@kiwik-one");
  });
});
