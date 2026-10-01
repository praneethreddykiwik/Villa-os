import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";

import {
  BOUNDS,
  DEFAULTS,
  defaultSettings,
  validateSettings,
} from "../src/lib/villa/settings";

/**
 * Calling hours and retry policy, moved out of the source and into settings.
 *
 * The dangerous direction here is not a rejected save — it is an accepted one.
 * A window that closes before it opens silences the queue forever and reports
 * only "outside calling hours"; a concurrency of fifty rings fifty phones from
 * one number. Both are refused below, and by CHECK constraints on the table,
 * because this row is reachable by anything holding the service key.
 */

// The suite is compiled into .test-build/ before it runs, so __dirname points
// there rather than at the sources these assertions read.
const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const BRAND = "brd_test";
const valid = {
  callingStartHour: 9,
  callingEndHour: 20,
  callingTimeZone: "Asia/Kolkata",
  maxConcurrentCalls: 1,
  maxAttempts: 2,
  retryBackoffMinutes: 60,
  callTimeoutMinutes: 15,
};

describe("nothing changes until somebody changes it", () => {
  test("the defaults are exactly the constants they replaced", () => {
    // If these drift, upgrading the app silently changes when customers are
    // called — which is the one thing this move must not do.
    assert.equal(DEFAULTS.callingStartHour, 9);
    assert.equal(DEFAULTS.callingEndHour, 20);
    assert.equal(DEFAULTS.callingTimeZone, "Asia/Kolkata");
    assert.equal(DEFAULTS.maxConcurrentCalls, 1);
    assert.equal(DEFAULTS.maxAttempts, 2);
    assert.equal(DEFAULTS.retryBackoffMinutes, 60);
    assert.equal(DEFAULTS.callTimeoutMinutes, 15);
  });

  test("the queue derives its constants from here rather than repeating them", () => {
    const src = read("src/lib/voice/queue.ts");
    assert.match(src, /MAX_CONCURRENT_CALLS = DEFAULTS\.maxConcurrentCalls/);
    assert.match(src, /MAX_ATTEMPTS = DEFAULTS\.maxAttempts/);
    assert.match(src, /CALL_TIMEOUT_MINUTES = DEFAULTS\.callTimeoutMinutes/);
    assert.match(src, /RETRY_BACKOFF_MINUTES = DEFAULTS\.retryBackoffMinutes/);
  });

  test("a brand with no row gets the defaults, not zeroes", () => {
    const s = defaultSettings(BRAND);
    assert.equal(s.brandId, BRAND);
    assert.equal(s.callingStartHour, DEFAULTS.callingStartHour);
    assert.equal(s.updatedAt, null);
  });

  test("a read never throws, so a dead database cannot stop the queue", () => {
    const src = read("src/lib/villa/settings.ts");
    const fn = src.slice(src.indexOf("export async function loadSettings"), src.indexOf("export function cachedSettings"));
    assert.match(fn, /catch \{/);
    assert.match(fn, /let value = defaultSettings\(brandId\)/);
  });
});

describe("a save that would break the queue is refused", () => {
  test("a window that closes before it opens", () => {
    const r = validateSettings(BRAND, { ...valid, callingStartHour: 20, callingEndHour: 9 });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.error : "", /start before they stop/i);
  });

  test("a window of zero length", () => {
    // 9 to 9 is never satisfied either, and reads as valid at a glance.
    const r = validateSettings(BRAND, { ...valid, callingStartHour: 9, callingEndHour: 9 });
    assert.equal(r.ok, false);
  });

  test("a concurrency that would ring the whole list at once", () => {
    const r = validateSettings(BRAND, { ...valid, maxConcurrentCalls: 50 });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.error : "", /between 1 and 10/);
  });

  test("a time zone the runtime cannot resolve", () => {
    // Stored unchecked, every dial would throw inside Intl instead.
    const r = validateSettings(BRAND, { ...valid, callingTimeZone: "Mars/Olympus" });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.error : "", /time zone/i);
  });

  test("a blank time zone", () => {
    assert.equal(validateSettings(BRAND, { ...valid, callingTimeZone: "  " }).ok, false);
  });

  test("a fractional hour", () => {
    assert.equal(validateSettings(BRAND, { ...valid, callingStartHour: 9.5 }).ok, false);
  });

  test("a missing field falls back to nothing, not to zero", () => {
    // Number(undefined) is NaN, not 0 — but Number("") is 0, and a start hour
    // silently becoming midnight is how people get called at 3am.
    const { callingStartHour: _omitted, ...rest } = valid;
    assert.equal(validateSettings(BRAND, rest).ok, false);
    assert.equal(validateSettings(BRAND, { ...valid, callingStartHour: "" }).ok, false);
  });

  test("zero attempts, which would queue numbers nobody ever calls", () => {
    assert.equal(validateSettings(BRAND, { ...valid, maxAttempts: 0 }).ok, false);
  });
});

describe("a sensible change is accepted", () => {
  test("a shorter day in another zone", () => {
    const r = validateSettings(BRAND, {
      ...valid,
      callingStartHour: 10,
      callingEndHour: 18,
      callingTimeZone: "Asia/Dubai",
      maxConcurrentCalls: 3,
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.settings.callingEndHour, 18);
      assert.equal(r.settings.callingTimeZone, "Asia/Dubai");
      assert.equal(r.settings.maxConcurrentCalls, 3);
    }
  });

  test("numbers arriving as strings from a form still validate", () => {
    const r = validateSettings(BRAND, { ...valid, maxConcurrentCalls: "2", callingEndHour: "21" });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.settings.maxConcurrentCalls, 2);
  });

  test("calling right through to midnight", () => {
    assert.equal(validateSettings(BRAND, { ...valid, callingEndHour: 24 }).ok, true);
  });
});

describe("the bounds the form shows are the bounds the server enforces", () => {
  test("every bounded field has a label a person can read", () => {
    for (const [key, b] of Object.entries(BOUNDS)) {
      assert.ok(b.label.length > 0, `${key} has no label`);
      assert.ok(b.min < b.max, `${key} has an empty range`);
    }
  });

  test("the table's CHECK constraints match those bounds", () => {
    // The table is the backstop. If the two disagree, a save the form allows
    // fails at the database with an error nobody can act on.
    const sql = read("supabase/villa_settings.sql");
    assert.match(sql, /max_concurrent_calls between 1 and 10/);
    assert.match(sql, /max_attempts between 1 and 5/);
    assert.match(sql, /retry_backoff_minutes between 5 and 1440/);
    assert.match(sql, /call_timeout_minutes between 2 and 120/);
    assert.match(sql, /calling_start_hour < calling_end_hour/);
  });

  test("the table is additive and drops nothing", () => {
    // The villa_* schema is live with real data.
    const sql = read("supabase/villa_settings.sql");
    assert.match(sql, /create table if not exists villa_settings/);
    assert.doesNotMatch(sql, /drop table|truncate|delete from/i);
  });

  test("the settings row is not readable with the anon key", () => {
    const sql = read("supabase/villa_settings.sql");
    assert.match(sql, /enable row level security/);
    assert.match(sql, /force row level security/);
  });
});

describe("the queue actually reads the settings", () => {
  const src = read("src/lib/voice/queue.ts");

  test("the pump loads them once per run, not per dial", () => {
    // Reading per iteration lets a change land mid-run and raise concurrency
    // between two dials of the same pass.
    const fn = src.slice(src.indexOf("export async function pumpQueue"));
    assert.match(fn, /const settings = await loadSettings\(/);
    assert.match(fn, /withinCallingHours\(new Date\(\), settings\)/);
  });

  test("concurrency is taken from the settings, not the constant", () => {
    const fn = src.slice(src.indexOf("export async function pumpQueue"));
    assert.match(fn, /inFlight >= settings\.maxConcurrentCalls/);
  });

  test("the calling-hours note carries no full stop of its own", () => {
    // Its two callers punctuate differently; when it ended in one, the panel
    // rendered "when that window opens..".
    const fn = src.slice(src.indexOf("export function callingHoursNote"), src.indexOf("const ACTIVE"));
    assert.match(fn, /window opens`/);
    assert.doesNotMatch(fn, /window opens\.`/);
  });

  test("the summary punctuates it, since it renders the string as-is", () => {
    assert.match(src, /\$\{callingHoursNote\(settings\)\}\./);
  });
});
