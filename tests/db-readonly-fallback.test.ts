import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Production returned, on every page backed by the JSON store:
 *
 *     ENOENT: no such file or directory, mkdir '/var/task/.data'
 *
 * The store picked its directory from `process.env.VERCEL`. That variable is
 * only present when a Vercel project has "Automatically expose System
 * Environment Variables" switched on; with it off the check failed, the store
 * tried to write inside the read-only deployment directory, and the dashboard,
 * showcase and connections pages all returned a server error while the pages
 * backed by Postgres kept working.
 *
 * The lesson is that the environment cannot be asked whether a directory is
 * writable — the filesystem has to be. These tests drive the real behaviour
 * against a directory the OS refuses, with no environment variable set.
 */

const TS_NODE = path.join(process.cwd(), ".test-build", "src", "lib", "db.js");

/** Run a snippet in a clean process with a controlled cwd and environment. */
function runIn(cwd: string, env: Record<string, string | undefined>, snippet: string): string {
  return execFileSync(process.execPath, ["-e", snippet], {
    cwd,
    // Clear the inherited hints first, then apply the case's own values —
    // the other order silently wiped the variable the test was setting.
    env: { ...process.env, OPS_DATA_DIR: undefined, VERCEL: undefined, VERCEL_ENV: undefined, ...env },
    encoding: "utf8",
  }).trim();
}

describe("the JSON store survives a read-only deployment directory", () => {
  test("falls back to /tmp when the working directory refuses a write, with no env hint", () => {
    // A directory the process genuinely cannot create inside — the same shape
    // as /var/task on a serverless host.
    const jail = fs.mkdtempSync(path.join(os.tmpdir(), "ro-cwd-"));
    fs.chmodSync(jail, 0o500); // r-x: listing allowed, creating denied

    try {
      const out = runIn(
        jail,
        {},
        `const db = require(${JSON.stringify(TS_NODE)});
         const d = db.read();
         console.log(JSON.stringify({ brands: (d.brands || []).length }));`,
      );
      const parsed = JSON.parse(out) as { brands: number };
      assert.ok(
        parsed.brands >= 1,
        "read() must return a usable store rather than throwing, so pages still render",
      );
    } finally {
      fs.chmodSync(jail, 0o700);
      fs.rmSync(jail, { recursive: true, force: true });
    }
  });

  test("an explicit OPS_DATA_DIR is still honoured, so tests stay isolated", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "explicit-"));
    try {
      const out = runIn(
        process.cwd(),
        { OPS_DATA_DIR: dir },
        `const db = require(${JSON.stringify(TS_NODE)});
         db.read();
         const fs = require("fs"), path = require("path");
         console.log(fs.existsSync(path.join(${JSON.stringify(dir)}, "db.json")) ? "here" : "elsewhere");`,
      );
      assert.equal(out, "here", "an explicit directory must never be silently redirected to /tmp");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
