import { mutate, read } from "../db";
import { uid } from "../ids";
import { logActivity } from "../engine/publisher";
import { isConfigured, startCall, toE164 } from "../bolna/client";
import type { VoiceQueueEntry, VoiceQueueStatus } from "./types";
import { DEFAULT_BRAND_ID } from "../bootstrap";
import { DEFAULTS, cachedSettings, loadSettings, type VillaSettings } from "../villa/settings";

/**
 * THE OUTBOUND CALL QUEUE.
 *
 * The desk hands over a list of numbers; this decides who is dialled, when,
 * and what happens when a call does not connect. Before it existed the only
 * way to place a call was one number typed into a dialog, and nothing
 * remembered the attempt — a no-answer was simply lost.
 *
 * WHY A QUEUE RATHER THAN A LOOP
 *
 * Every entry here rings a real phone and spends real money. A loop over an
 * array has no memory: it cannot survive a redeploy, it retries nothing, it
 * dials at 3am, and a double-submit calls everyone twice. So the list is
 * state, each dial is a claim against that state, and the pump is allowed to
 * run twice concurrently without anyone being called twice.
 *
 * WHAT DRIVES IT
 *
 *   · the webhook — a finished call advances its own entry and dials the next,
 *     which is what keeps a run moving with nobody watching;
 *   · the cron heartbeat — picks up retries whose backoff has elapsed, and
 *     recovers a run the webhook never finished (a call the provider never
 *     reported on would otherwise hold the queue open forever);
 *   · an operator pressing Run.
 *
 * All three call `pumpQueue`, and it is safe for all three to happen at once.
 */

/**
 * One at a time, deliberately.
 *
 * A Bolna agent is attached to one outbound number. Two concurrent calls from
 * the same number is not twice the throughput — it is the second customer
 * hearing a busy tone, and the provider billing for it.
 */
export const MAX_CONCURRENT_CALLS = DEFAULTS.maxConcurrentCalls;

/** A dial that never reported back. Past this the entry is unstuck for retry. */
export const CALL_TIMEOUT_MINUTES = DEFAULTS.callTimeoutMinutes;

/** No-answer gets one more try, an hour later. A refusal gets none. */
export const MAX_ATTEMPTS = DEFAULTS.maxAttempts;
export const RETRY_BACKOFF_MINUTES = DEFAULTS.retryBackoffMinutes;

/**
 * Nobody is called outside these hours, in the brand's local time.
 *
 * This is not politeness, it is the difference between a sales call and a
 * nuisance call. A queue loaded at midnight waits until morning rather than
 * ringing two hundred phones while people sleep.
 */
export const CALLING_HOURS = {
  startHour: DEFAULTS.callingStartHour,
  endHour: DEFAULTS.callingEndHour,
  timeZone: DEFAULTS.callingTimeZone,
} as const;

/**
 * The window actually in force.
 *
 * Every function below takes settings as an optional argument rather than
 * reading them itself, so a caller that has already loaded them (pumpQueue,
 * which must not race a mid-run change) and a caller that cannot await
 * (queueSummary, which renders a panel) both get a consistent answer.
 */
type Window = Pick<VillaSettings, "callingStartHour" | "callingEndHour" | "callingTimeZone">;
const windowOr = (s?: Window): Window => s ?? cachedSettings(DEFAULT_BRAND_ID);

/** The hour of day at `when` in the calling time zone. */
export function localHour(when: Date = new Date(), settings?: Window): number {
  const w = windowOr(settings);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: w.callingTimeZone,
    hour: "numeric",
    hour12: false,
  }).formatToParts(when);
  return Number(parts.find((p) => p.type === "hour")?.value ?? 0);
}

export function withinCallingHours(when: Date = new Date(), settings?: Window): boolean {
  const w = windowOr(settings);
  const h = localHour(when, w);
  return h >= w.callingStartHour && h < w.callingEndHour;
}

/**
 * The queue is idle outside calling hours; this is what the UI shows instead.
 *
 * No trailing full stop: every caller appends its own, and two of them read as
 * "when that window opens..".
 */
export function callingHoursNote(settings?: Window): string {
  const w = windowOr(settings);
  const zone = w.callingTimeZone === "Asia/Kolkata" ? "IST" : w.callingTimeZone;
  return `Calls run between ${w.callingStartHour}:00 and ${w.callingEndHour}:00 ${zone}. Anything queued now will be dialled when that window opens`;
}

const ACTIVE: VoiceQueueStatus[] = ["queued", "calling"];

/** Same person, however the number was typed. */
export function queueKey(phone: string): string {
  return phone.replace(/[^\d]/g, "").slice(-10);
}

export interface EnqueueInput {
  brandId: string;
  /** Raw, as the operator typed or pasted them. */
  phones: string[];
  agentId: string;
  createdBy: string;
  /** Optional per-number context, keyed by the raw number. */
  names?: Record<string, string>;
  leadIds?: Record<string, string>;
}

export interface EnqueueResult {
  added: VoiceQueueEntry[];
  /** Rejected, with the reason an operator can act on. */
  rejected: { phone: string; reason: string }[];
}

/**
 * Add numbers to the queue.
 *
 * Rejections are returned rather than thrown: pasting sixty numbers of which
 * two are malformed should queue fifty-eight and name the two, not fail the
 * whole paste.
 */
export function enqueueCalls(input: EnqueueInput): EnqueueResult {
  const now = new Date().toISOString();
  const added: VoiceQueueEntry[] = [];
  const rejected: { phone: string; reason: string }[] = [];

  const existing = read().voiceCallQueue ?? [];
  // Within this brand only: two brands calling the same number is two
  // different businesses, and neither knows about the other.
  const activeKeys = new Set(
    existing
      .filter((e) => e.brandId === input.brandId && ACTIVE.includes(e.status))
      .map((e) => queueKey(e.phone)),
  );
  const seenThisBatch = new Set<string>();

  for (const raw of input.phones) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const phone = toE164(trimmed);
    if (!phone) {
      rejected.push({
        phone: trimmed,
        reason: "not a dialable number — it needs a country code, e.g. +919876543210",
      });
      continue;
    }

    const key = queueKey(phone);
    if (seenThisBatch.has(key)) {
      rejected.push({ phone: trimmed, reason: "listed twice in this batch" });
      continue;
    }
    if (activeKeys.has(key)) {
      rejected.push({ phone: trimmed, reason: "already waiting in the queue" });
      continue;
    }
    seenThisBatch.add(key);

    added.push({
      id: uid("vq"),
      brandId: input.brandId,
      agentId: input.agentId,
      phone,
      name: input.names?.[raw]?.trim() || null,
      leadId: input.leadIds?.[raw] ?? null,
      status: "queued",
      attempts: 0,
      maxAttempts: cachedSettings(input.brandId).maxAttempts,
      executionId: null,
      lastError: null,
      notBefore: null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
  }

  if (added.length > 0) {
    mutate((db) => {
      db.voiceCallQueue ??= [];
      db.voiceCallQueue.push(...added);
    });
  }

  return { added, rejected };
}

function patch(id: string, fields: Partial<VoiceQueueEntry>): void {
  mutate((db) => {
    const e = (db.voiceCallQueue ??= []).find((x) => x.id === id);
    if (e) Object.assign(e, fields, { updatedAt: new Date().toISOString() });
  });
}

/**
 * Release a dial that never reported back.
 *
 * Bolna posts a terminal status for every call it starts, but a dropped
 * webhook or a provider fault would otherwise leave an entry `calling`
 * forever, and since that counts against the concurrency limit the whole
 * queue stops. After the timeout the attempt is treated as spent.
 */
function reclaimStalled(settings?: Pick<VillaSettings, "callTimeoutMinutes" | "retryBackoffMinutes">): number {
  const cfg = settings ?? cachedSettings(DEFAULT_BRAND_ID);
  const cutoff = Date.now() - cfg.callTimeoutMinutes * 60_000;
  let reclaimed = 0;
  mutate((db) => {
    for (const e of db.voiceCallQueue ?? []) {
      if (e.status !== "calling") continue;
      if (new Date(e.updatedAt).getTime() > cutoff) continue;
      reclaimed += 1;
      const spent = e.attempts >= e.maxAttempts;
      e.status = spent ? "failed" : "queued";
      e.lastError = "the provider never reported the outcome of this call";
      e.notBefore = spent ? null : new Date(Date.now() + cfg.retryBackoffMinutes * 60_000).toISOString();
      e.completedAt = spent ? new Date().toISOString() : null;
      e.updatedAt = new Date().toISOString();
    }
  });
  return reclaimed;
}

export interface PumpResult {
  dialled: number;
  /** Why no more calls were started. Always set when `dialled` is short. */
  idle: string | null;
  reclaimed: number;
}

/**
 * Start as many calls as the concurrency limit allows. Never throws.
 *
 * The claim — flipping an entry to `calling` — happens in one `mutate` before
 * the provider is contacted, so two pumps racing cannot both take the same
 * entry. If the provider then refuses, the claim is released.
 */
export async function pumpQueue(brandId?: string): Promise<PumpResult> {
  // Loaded once for the whole run. Reading per iteration would let a settings
  // change land mid-run and, for instance, raise concurrency between two
  // dials of the same pass.
  const settings = await loadSettings(brandId ?? DEFAULT_BRAND_ID);
  const reclaimed = reclaimStalled(settings);

  if (!isConfigured()) {
    return { dialled: 0, reclaimed, idle: "the voice agent is not connected" };
  }
  if (!withinCallingHours(new Date(), settings)) {
    return { dialled: 0, reclaimed, idle: callingHoursNote(settings) };
  }

  let dialled = 0;
  let idle: string | null = null;

  for (;;) {
    const now = Date.now();
    const claimed = mutate((db) => {
      const queue = (db.voiceCallQueue ??= []);
      const all = queue.filter((e) => !brandId || e.brandId === brandId);
      // Counted across every brand, deliberately. The limit exists because one
      // outbound number can hold one conversation at a time, and brands share
      // that number — counting per brand meant three brands each believed they
      // had the line to themselves and the customer got a busy tone we still
      // paid for.
      const inFlight = queue.filter((e) => e.status === "calling").length;
      if (inFlight >= settings.maxConcurrentCalls) {
        return {
          entry: null,
          reason:
            settings.maxConcurrentCalls === 1
              ? "a call is already in progress"
              : `${settings.maxConcurrentCalls} calls are already in progress`,
        };
      }

      const next = all
        .filter((e) => e.status === "queued")
        .filter((e) => !e.notBefore || new Date(e.notBefore).getTime() <= now)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!next) {
        const waiting = all.some((e) => e.status === "queued");
        return { entry: null, reason: waiting ? "the next retry is not due yet" : "nothing left to call" };
      }

      next.status = "calling";
      next.attempts += 1;
      next.lastError = null;
      next.updatedAt = new Date().toISOString();
      return { entry: { ...next }, reason: null };
    });

    if (!claimed.entry) {
      idle = claimed.reason;
      break;
    }

    const entry = claimed.entry;
    const userData: Record<string, string> = {};
    if (entry.name) userData.lead_name = entry.name;

    let result;
    try {
      result = await startCall({ agentId: entry.agentId, phone: entry.phone, userData });
    } catch (e) {
      result = { ok: false as const, error: e instanceof Error ? e.message : "the call could not be started" };
    }

    if (!result.ok) {
      // A provider refusal is not the customer's fault, so it does not consume
      // the retry allowance quietly — it is recorded verbatim. "balance
      // exhausted" is actionable; "call failed" sends somebody to read logs.
      const spent = entry.attempts >= entry.maxAttempts;
      patch(entry.id, {
        status: spent ? "failed" : "queued",
        lastError: result.error,
        notBefore: spent ? null : new Date(Date.now() + settings.retryBackoffMinutes * 60_000).toISOString(),
        completedAt: spent ? new Date().toISOString() : null,
      });
      idle = result.error;
      break;
    }

    patch(entry.id, { executionId: result.data.executionId ?? null });
    logActivity(
      entry.brandId,
      "voice_call_started",
      `Voice agent called ${entry.name ?? entry.phone} (queued${entry.attempts > 1 ? `, attempt ${entry.attempts}` : ""})`,
      "call-queue",
    );
    dialled += 1;
  }

  return { dialled, reclaimed, idle };
}

/**
 * Record how a finished call went and free the slot.
 *
 * Called from the webhook the moment a call reaches a terminal status. A
 * no-answer is the one outcome worth retrying: the person did not refuse, they
 * were not there. A call that connected is done whatever was said — the
 * transcript and the WhatsApp follow-up are handled downstream.
 */
export function settleQueueEntry(input: {
  executionId: string;
  phone: string | null;
  brandId: string;
  outcome: "completed" | "no_answer" | "failed" | "in_progress";
}): VoiceQueueEntry | null {
  if (input.outcome === "in_progress") return null;

  return mutate((db) => {
    const queue = (db.voiceCallQueue ??= []);
    // By execution id first — it is exact. The phone is the fallback for a
    // call the provider started before it told us the execution id.
    const key = input.phone ? queueKey(input.phone) : null;
    const entry =
      queue.find((e) => e.executionId === input.executionId) ??
      (key
        ? queue.find((e) => e.status === "calling" && e.brandId === input.brandId && queueKey(e.phone) === key)
        : undefined);
    if (!entry || entry.status !== "calling") return null;

    const now = new Date().toISOString();
    const retryable = input.outcome === "no_answer" && entry.attempts < entry.maxAttempts;

    entry.executionId = entry.executionId ?? input.executionId;
    entry.status = retryable ? "queued" : input.outcome === "completed" ? "done" : "failed";
    entry.lastError = input.outcome === "completed" ? null : `call ended: ${input.outcome.replace("_", " ")}`;
    entry.notBefore = retryable
      ? new Date(Date.now() + cachedSettings(entry.brandId).retryBackoffMinutes * 60_000).toISOString()
      : null;
    entry.completedAt = retryable ? null : now;
    entry.updatedAt = now;
    return { ...entry };
  });
}

export function cancelQueued(brandId: string, ids: string[]): number {
  const wanted = new Set(ids);
  let cancelled = 0;
  mutate((db) => {
    for (const e of db.voiceCallQueue ?? []) {
      // A call already ringing is not cancelled here — the person's phone is
      // lit up and the provider owns the call. Only what has not started yet.
      if (e.brandId !== brandId || !wanted.has(e.id) || e.status !== "queued") continue;
      e.status = "cancelled";
      e.completedAt = new Date().toISOString();
      e.updatedAt = e.completedAt;
      cancelled += 1;
    }
  });
  return cancelled;
}

export interface QueueSummary {
  entries: VoiceQueueEntry[];
  counts: Record<VoiceQueueStatus, number>;
  callingNow: boolean;
  withinCallingHours: boolean;
  note: string | null;
}

export function queueSummary(brandId: string, limit = 200): QueueSummary {
  const all = (read().voiceCallQueue ?? [])
    .filter((e) => e.brandId === brandId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const counts: Record<VoiceQueueStatus, number> = {
    queued: 0, calling: 0, done: 0, failed: 0, cancelled: 0,
  };
  for (const e of all) counts[e.status] += 1;
  const settings = cachedSettings(brandId);
  const open = withinCallingHours(new Date(), settings);
  return {
    entries: all.slice(0, limit),
    counts,
    callingNow: counts.calling > 0,
    withinCallingHours: open,
    // Rendered as-is by the panel, so it ends a sentence here. The pump's
    // `idle` string is capitalised and punctuated by its caller instead,
    // which is why callingHoursNote() itself carries no full stop.
    note: !open && counts.queued > 0 ? `${callingHoursNote(settings)}.` : null,
  };
}
