import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";

import { MISSED_CALL_TEMPLATE } from "../src/lib/osf/voice-bridge";

/**
 * Calling a list, and what happens to the people who never picked up.
 *
 * The expensive failure here is not a crash — it is messaging somebody three
 * times because a campaign retried them three times, or messaging somebody who
 * opted out. Both are pinned below.
 */

// The suite is compiled into .test-build/ before it runs, so __dirname points
// there rather than at the sources these assertions read.
const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const BRIDGE = "src/lib/osf/voice-bridge.ts";
const WEBHOOK = "src/app/api/webhooks/bolna/route.ts";
const QUEUE = "src/lib/voice/queue.ts";

describe("a missed call is followed up on WhatsApp", () => {
  test("the webhook calls the follow-up", () => {
    assert.match(read(WEBHOOK), /notifyMissedCall\(/);
  });

  test("only once retries are spent, so a campaign sends one message not three", () => {
    // settleQueueEntry returns "queued" while attempts remain and "failed"
    // once they are gone. Keying on "failed" is the whole dedup strategy.
    const src = read(WEBHOOK);
    assert.match(src, /settled\?\.status === "failed"/);
    assert.match(src, /result\.record\.outcome === "no_answer"/);
  });

  test("a call that was answered never triggers it", () => {
    const src = read(WEBHOOK);
    // The call site, not the import at the top of the file.
    const at = src.indexOf("await notifyMissedCall(");
    assert.ok(at > 0, "expected an awaited notifyMissedCall call site");
    const guard = src.slice(Math.max(0, at - 700), at);
    assert.match(guard, /no_answer/, "the missed-call path must be gated on no_answer");
  });

  test("the retry rule it depends on is still the retry rule", () => {
    // If no-answer stopped being retryable, or "failed" stopped being the
    // terminal status, the guard above would silently never fire.
    const src = read(QUEUE);
    assert.match(src, /input\.outcome === "no_answer" && entry\.attempts < entry\.maxAttempts/);
    assert.match(src, /entry\.status = retryable \? "queued"/);
  });

  test("it is awaited, not fired and forgotten", () => {
    // On a serverless function, work still in flight when the response
    // returns is killed with the process.
    assert.match(read(WEBHOOK), /await notifyMissedCall\(/);
  });
});

describe("the follow-up cannot double-send or reach the wrong person", () => {
  const src = read(BRIDGE);

  test("a webhook retry is recognised and dropped", () => {
    assert.match(src, /activity_type", "missed_call_followup"/);
    assert.match(src, /already handled — this is a webhook retry/);
  });

  test("an opt-out outranks the campaign", () => {
    const fn = src.slice(src.indexOf("export async function notifyMissedCall"));
    assert.match(fn, /lead\.opted_out/);
    assert.match(fn, /opted out/);
  });

  test("a call with no number sends nothing", () => {
    const fn = src.slice(src.indexOf("export async function notifyMissedCall"));
    assert.match(fn, /no phone number/);
  });

  test("it never throws — the call record must survive a failed follow-up", () => {
    const fn = src.slice(src.indexOf("export async function notifyMissedCall"));
    assert.match(fn, /catch \(e\)/);
    assert.match(fn, /return \{ \.\.\.empty, skipped:/);
  });

  test("it logs what it did, so the next retry can see it", () => {
    const fn = src.slice(src.indexOf("export async function notifyMissedCall"));
    assert.match(fn, /type: "missed_call_followup"/);
    assert.match(fn, /executionId: input\.executionId/);
  });
});

describe("the message itself", () => {
  const src = read(BRIDGE);

  test("it does not thank someone for a conversation that never happened", () => {
    // FOLLOW_UP_TEMPLATE thanks people for speaking. Sending that to somebody
    // who never picked up reads as a machine talking to itself.
    assert.notEqual(MISSED_CALL_TEMPLATE, "call_followup_hot");
    assert.notEqual(MISSED_CALL_TEMPLATE, "call_followup_warm");
    const body = src.slice(src.indexOf("function missedCallText"), src.indexOf("export interface MissedCallResult"));
    assert.doesNotMatch(body, /thank you for speaking|thank you for your time/i);
    assert.match(body, /couldn't reach you/i);
  });

  test("it offers a next step rather than just reporting a miss", () => {
    const body = src.slice(src.indexOf("function missedCallText"), src.indexOf("export interface MissedCallResult"));
    assert.match(body, /brochure/i);
    assert.match(body, /call back/i);
  });

  test("Meta gets a template, Evolution gets plain text", () => {
    // On Meta there is no open 24-hour window for somebody who has never
    // written to us, so free text would be rejected at the edge.
    const fn = src.slice(src.indexOf("export async function notifyMissedCall"));
    assert.match(fn, /activeProvider\(\) === "meta"/);
    assert.match(fn, /sendReengagement\(/);
    assert.match(fn, /sendPlainText\(/);
  });
});
