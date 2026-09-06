import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before, describe } from "node:test";
import { cleanup, isolate } from "./helpers";

/**
 * Voice agent — inbound execution webhook and ingestion.
 *
 * The route file is pinned by source (route handlers are outside the test
 * build); the ingestion it delegates to runs for real against an isolated
 * store, because idempotency and "side effects exactly once" are the
 * properties a replayed webhook will test in production.
 */

const dir = isolate("voice-webhook");
after(() => cleanup(dir));

const { read, mutate } = require("../src/lib/db") as typeof import("../src/lib/db");
const { normaliseExecution, turnsFromText } =
  require("../src/lib/bolna/client") as typeof import("../src/lib/bolna/client");
const calls = require("../src/lib/voice/calls") as typeof import("../src/lib/voice/calls");

function src(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

let brandId = "";
let orgId = "";
before(() => {
  const db = read();
  brandId = db.brands[0]?.id ?? "";
  orgId = db.workspaces[0]?.id ?? "ws_default";
  assert.ok(brandId, "bootstrap provides a brand");
});

const payload = (over: Record<string, unknown> = {}) => ({
  id: "exec-1",
  agent_id: "agent-1",
  status: "completed",
  conversation_duration: 42,
  total_cost: 3.2,
  created_at: "2026-09-01T10:00:00Z",
  user_number: "+919876543210",
  agent_number: "+918035739222",
  transcript: "assistant: Hello, this is Sarah from Glentree.\nuser: Hi, I am interested in a site visit this weekend.\nassistant: Great, Saturday 11am works?",
  extracted_data: { Lead: { "Customer Name": { subjective: "Ravi Kumar", confidence: 0.9 } } },
  telephony_data: { duration: 45, call_type: "outbound", recording_url: "https://example.com/rec.mp3", hangup_by: "Caller" },
  ...over,
});

describe("normalisation", () => {
  test("string transcript becomes turns and top-level numbers are read", () => {
    const e = normaliseExecution(payload());
    assert.ok(e);
    assert.equal(e!.durationSeconds, 42);
    assert.equal(e!.toNumber, "+919876543210");
    assert.equal(e!.fromNumber, "+918035739222");
    // The client keeps a string transcript as a string; the voice record splits it.
    assert.equal(e!.turns, null);
    const turns = turnsFromText(e!.transcript);
    assert.equal(turns?.length, 3);
    assert.equal(turns?.[1].role, "user");
    assert.equal(turnsFromText("nope"), null);
    const record = calls.toRecord(e!, brandId);
    assert.equal(record.turns.length, 3);
    assert.equal(record.turns[1].role, "caller");
  });

  test("extraction categories flatten to readable keys without the extractor's working", () => {
    const flat = calls.flattenExtracted({ Lead: { "Customer Name": { subjective: "Ravi", confidence: 0.9, reasoning: "said so" } }, plain: "x" });
    assert.deepEqual(flat, { "Lead · Customer Name": "Ravi", plain: "x" });
  });

  test("extracted name ignores project/company names", () => {
    assert.equal(calls.extractedName({ "Lead · Project Name": "Villa Serene", "Lead · Interested": "yes" }), null);
    assert.equal(calls.extractedName({ "Lead · Project Name": "Villa Serene", "Lead · Customer Name": "Ravi" }), "Ravi");
    assert.equal(calls.extractedName({ "Lead · Company Name": "Acme", "Full Name": "Priya" }), "Priya");
  });

  test("terminal statuses and outcomes", () => {
    assert.equal(calls.isTerminal("call-disconnected"), false);
    assert.equal(calls.isTerminal("completed"), true);
    assert.equal(calls.outcomeOf("no-answer", null), "no_answer");
    assert.equal(calls.outcomeOf("completed", 0), "no_answer");
    assert.equal(calls.outcomeOf("failed", null), "failed");
    assert.equal(calls.outcomeOf("in-progress", null), "in_progress");
  });

  test("intent is read from the caller's words, not the agent's", () => {
    const agentOnly = calls.detectIntent({ extracted: {}, transcript: null, turns: [{ role: "agent", text: "Shall I book a site visit?" }] });
    assert.equal(agentOnly, "none");
    const cb = calls.detectIntent({ extracted: {}, transcript: null, turns: [{ role: "caller", text: "Please call me back tomorrow" }] });
    assert.equal(cb, "callback");
    const no = calls.detectIntent({ extracted: {}, transcript: null, turns: [{ role: "caller", text: "Not interested, wrong number" }] });
    assert.equal(no, "none");
  });
});

describe("ingestion", () => {
  test("an in-progress update is stored but creates nothing", () => {
    const e = normaliseExecution(payload({ status: "in-progress", transcript: null, extracted_data: null, conversation_duration: null }))!;
    const r = calls.ingestExecution(e, { brandId, orgId });
    assert.equal(r.created, true);
    assert.equal(r.finalised, false);
    assert.equal(read().voiceCalls.length, 1);
    assert.equal(read().leads.filter((l) => l.source === "voice").length, 0);
  });

  test("the terminal update finalises once: customer, transcript, lead, notification", () => {
    const e = normaliseExecution(payload())!;
    const r = calls.ingestExecution(e, { brandId, orgId });
    assert.equal(r.created, false);
    assert.equal(r.finalised, true);
    assert.equal(r.record.outcome, "completed");
    assert.equal(r.record.intent, "interested");
    assert.ok(r.record.customerId);
    assert.ok(r.record.leadId);
    assert.equal(r.record.leadCreated, true);

    const db = read();
    assert.equal(db.voiceCalls.length, 1);
    const customer = db.customers.find((c) => c.id === r.record.customerId)!;
    assert.equal(customer.source, "voice");
    assert.equal(customer.name, "Ravi Kumar");
    const lead = db.leads.find((l) => l.id === r.record.leadId)!;
    assert.equal(lead.source, "voice");
    assert.equal(lead.brandId, brandId);
    const msg = db.opsMessages.find((m) => m.externalId === "exec-1")!;
    assert.equal(msg.channel, "voice");
    assert.match(msg.body, /Caller: Hi, I am interested/);
    assert.equal(db.opsNotifications.filter((n) => n.event === "voice.lead_created").length, 1);

    // Replay: nothing doubles.
    const again = calls.ingestExecution(e, { brandId, orgId });
    assert.equal(again.finalised, false);
    const after2 = read();
    assert.equal(after2.voiceCalls.length, 1);
    assert.equal(after2.leads.filter((l) => l.source === "voice").length, 1);
    assert.equal(after2.opsMessages.filter((m) => m.externalId === "exec-1").length, 1);
    assert.equal(after2.opsNotifications.filter((n) => n.event === "voice.lead_created").length, 1);
  });

  test("a late non-terminal payload cannot regress a finalised call", () => {
    const before = read().voiceCalls.find((c) => c.executionId === "exec-1")!;
    const e = normaliseExecution(payload({ status: "ringing", transcript: null, extracted_data: null, conversation_duration: null }))!;
    const r = calls.ingestExecution(e, { brandId, orgId });
    assert.equal(r.finalised, false);
    assert.equal(r.record.status, "completed");
    assert.equal(r.record.outcome, "completed");
    assert.equal(r.record.durationSec, before.durationSec);
    assert.equal(r.record.leadId, before.leadId);
    assert.equal(r.record.finalisedAt, before.finalisedAt);
    assert.equal(read().voiceCalls.filter((c) => c.executionId === "exec-1").length, 1);
  });

  test("a second call from a known number links the existing lead instead of forking it", () => {
    const e = normaliseExecution(payload({ id: "exec-2", transcript: "user: yes please send me the brochure" }))!;
    const r = calls.ingestExecution(e, { brandId, orgId });
    assert.equal(r.record.leadCreated, false);
    assert.ok(r.record.leadId);
    assert.equal(read().leads.filter((l) => l.source === "voice").length, 1);
  });

  test("an unanswered call creates no lead and no transcript", () => {
    const e = normaliseExecution(payload({ id: "exec-3", status: "no-answer", user_number: "+919000000001", transcript: null, extracted_data: null, conversation_duration: 0 }))!;
    const r = calls.ingestExecution(e, { brandId, orgId });
    assert.equal(r.record.outcome, "no_answer");
    assert.equal(r.record.leadId, null);
    assert.equal(read().opsMessages.some((m) => m.externalId === "exec-3"), false);
    mutate((d) => void (d.voiceCalls = d.voiceCalls.filter((c) => c.executionId !== "exec-3")));
  });

  test("a no-answer later reclassified as completed still files the transcript and lead", () => {
    const first = normaliseExecution(payload({ id: "exec-4", status: "no-answer", user_number: "+919000000002", transcript: null, extracted_data: null, conversation_duration: 0 }))!;
    assert.equal(calls.ingestExecution(first, { brandId, orgId }).finalised, true);
    const second = normaliseExecution(payload({ id: "exec-4", status: "completed", user_number: "+919000000002", transcript: "user: interested in site visit", extracted_data: null, conversation_duration: 40 }))!;
    const r = calls.ingestExecution(second, { brandId, orgId });
    assert.equal(r.finalised, true);
    assert.equal(r.record.outcome, "completed");
    assert.ok(r.record.leadId);
    assert.equal(read().opsMessages.filter((m) => m.externalId === "exec-4").length, 1);
    // A completed replay does not finalise a third time.
    assert.equal(calls.ingestExecution(second, { brandId, orgId }).finalised, false);
    assert.equal(read().opsMessages.filter((m) => m.externalId === "exec-4").length, 1);
    mutate((d) => void (d.voiceCalls = d.voiceCalls.filter((c) => c.executionId !== "exec-4")));
  });
});

describe("webhook route", () => {
  const route = src("src/app/api/webhooks/bolna/route.ts");

  test("fails closed without the secret, reads it from a header, compares constant-time", () => {
    assert.match(route, /if \(!expected\) throw new AuthError\(.*503\)/);
    assert.match(route, /headers\.get\("x-voice-secret"\)/);
    assert.match(route, /process\.env\.VOICE_WEBHOOK_SECRET/);
    assert.doesNotMatch(route, /searchParams\.get\("secret"\)/);
    assert.match(route, /timingSafeEqual/);
  });

  test("is listed as self-authenticating in the middleware", () => {
    assert.match(src("src/middleware.ts"), /"\/api\/webhooks\/bolna"/);
  });

  test("delegates to the idempotent ingestion path", () => {
    assert.match(route, /ingestExecution\(/);
  });
});
