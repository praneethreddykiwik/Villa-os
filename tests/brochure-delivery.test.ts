import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";

/**
 * What a customer actually receives after asking for the brochure on a call.
 *
 * Every defect pinned here was found by auditing the live path, and every one
 * of them is invisible from inside the code: the send "succeeds", the log is
 * quiet, and the person on the phone gets nothing, or gets 30MB they never
 * asked for.
 */

// The suite is compiled into .test-build/ before it runs, so __dirname points
// there rather than at the sources these assertions read.
const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const EXECUTE = "src/lib/osf/agent/execute.ts";
const BRIDGE = "src/lib/osf/voice-bridge.ts";
const EVOLUTION = "src/lib/osf/evolution/client.ts";
const WEBHOOK = "src/app/api/webhooks/bolna/route.ts";
const CRON = "src/app/api/voice/queue/run/route.ts";
const QUEUE = "src/lib/voice/queue.ts";

describe("one document, not the whole shelf", () => {
  const src = read(EXECUTE);

  test("a document kind sends one file; images may send several", () => {
    // Two brochures are flagged shareable — 12.6MB and 17.4MB. Sending both
    // is 30MB of unasked-for WhatsApp.
    assert.match(src, /params\.limit \?\? \(kind === "image" \? 3 : 1\)/);
  });

  test("selection is deterministic, not whatever Postgres returns first", () => {
    // Without an order the caption lands on an arbitrary row.
    assert.match(src, /\.order\("created_at", \{ ascending: false \}\)/);
  });

  test("a project filter that matches nothing falls back instead of sending nothing", () => {
    // A lead tagged to a project whose assets carry a different or null
    // project_id matched zero rows — so the customer was told the brochure was
    // coming and then got nothing.
    assert.match(src, /build\(true\)/);
    assert.match(src, /build\(false\)/);
    assert.match(src, /lead\.project_interest/);
  });
});

describe("the promise is taken back when nothing arrives", () => {
  const src = read(BRIDGE);

  test("a total delivery failure sends a correction", () => {
    assert.match(src, /didn't attach properly at my end/);
  });

  test("the correction is keyed on nothing having been delivered", () => {
    assert.match(src, /const deliveredAny =/);
    assert.match(src, /if \(!deliveredAny\)/);
  });

  test("a partial success does not trigger it", () => {
    // Someone who got the brochure but not the location must not be told the
    // whole thing failed.
    const fn = src.slice(src.indexOf("const deliveredAny ="), src.indexOf("const deliveredAny =") + 400);
    assert.match(fn, /Object\.keys\(result\.delivered\)\.length > 0 \|\| result\.locationSent/);
  });

  test("the correction cannot itself throw and lose the result", () => {
    const fn = src.slice(src.indexOf("didn't attach properly") - 400, src.indexOf("didn't attach properly") + 400);
    assert.match(fn, /\.catch\(\(\) => \{\}\)/);
  });
});

describe("the send cannot hang or be killed mid-delivery", () => {
  test("the webhook has a budget of its own", () => {
    // Without one it took the platform default — the shortest in the app —
    // while awaiting a 20s LLM pass plus multi-megabyte uploads.
    const src = read(WEBHOOK);
    assert.match(src, /export const maxDuration = 300;/);
  });

  test("every comparable route already set one, so this was the outlier", () => {
    for (const f of ["src/app/api/osf/whatsapp/route.ts", "src/app/api/voice/queue/run/route.ts"]) {
      assert.match(read(f), /export const maxDuration/, `${f} lost its budget`);
    }
  });

  test("Evolution sends time out rather than blocking forever", () => {
    // Evolution downloads our file before it answers, so a send is only as
    // fast as its fetch of a 17MB PDF.
    const src = read(EVOLUTION);
    assert.match(src, /AbortSignal\.timeout\(SEND_TIMEOUT_MS\)/);
    assert.match(src, /const SEND_TIMEOUT_MS = /);
  });
});

describe("the dialler cannot wedge itself", () => {
  test("the cron unsticks a brand whose last call never reported back", () => {
    // reclaimStalled only runs inside pumpQueue. A brand with no queued
    // entries left was skipped, so the call timeout elapsed in no code path.
    const src = read(CRON);
    assert.match(src, /e\.status === "queued" \|\| e\.status === "calling"/);
  });

  test("concurrency is counted across brands, not within one", () => {
    // Brands share one outbound number. Counting per brand meant each believed
    // it had the line to itself.
    const src = read(QUEUE);
    const pump = src.slice(src.indexOf("export async function pumpQueue"));
    assert.match(pump, /const inFlight = queue\.filter\(\(e\) => e\.status === "calling"\)\.length/);
  });

  test("the timeout the reaper depends on still exists", () => {
    assert.match(read(QUEUE), /CALL_TIMEOUT_MINUTES/);
  });
});
