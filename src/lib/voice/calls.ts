import { mutate, read } from "../db";
import { uid } from "../ids";
import { scoreLead } from "../crm/rules";
import { logActivity } from "../engine/publisher";
import { normalisePhone, upsertCustomer } from "../ops/customers";
import { notify } from "../ops/audit";
import { turnsFromText, type BolnaExecution } from "../bolna/client";
import type { Lead } from "../crm/types";
import type { VoiceCallRecord, VoiceOutcome, VoiceTurn } from "./types";

/**
 * VOICE CALL INGESTION — one execution payload in, one normalised record out.
 *
 * Called from the provider webhook on every status change and from the
 * overview backfill. Both paths are idempotent by execution id: a replayed
 * webhook or a backfill of a call the webhook already delivered updates the
 * row in place, and the terminal side effects (customer, transcript, lead,
 * notification) run exactly once, guarded by `finalisedAt`.
 */

/** Documented terminal statuses. `call-disconnected` is soft — `completed` follows. */
export const TERMINAL_STATUSES = new Set([
  "completed", "no-answer", "busy", "failed", "canceled", "cancelled", "stopped", "error", "balance-low",
]);

export function isTerminal(status: string | null): boolean {
  return status !== null && TERMINAL_STATUSES.has(status.toLowerCase());
}

export function outcomeOf(status: string | null, durationSec: number | null): VoiceOutcome {
  const s = (status ?? "").toLowerCase();
  if (!isTerminal(s)) return "in_progress";
  if (s === "completed") return durationSec !== null && durationSec > 0 ? "completed" : "no_answer";
  if (s === "no-answer" || s === "busy" || s === "canceled" || s === "cancelled" || s === "stopped") return "no_answer";
  return "failed";
}

function normaliseRole(role: string): VoiceTurn["role"] {
  const r = role.toLowerCase();
  return r === "assistant" || r === "agent" || r === "bot" || r === "ai" ? "agent" : "caller";
}

/**
 * Extraction results arrive as Category → Field → { subjective | objective |
 * value | answer, confidence, reasoning }, or as a flat map. Both collapse to
 * "Category · Field" → text; confidence and reasoning are dropped because they
 * are the extractor's working, not the answer.
 */
export function flattenExtracted(input: Record<string, unknown> | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  const scalar = (v: unknown): string | null =>
    typeof v === "string" ? v.trim() || null
    : typeof v === "number" || typeof v === "boolean" ? String(v)
    : null;
  const leaf = (v: unknown): string | null => {
    const direct = scalar(v);
    if (direct !== null) return direct;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const r = v as Record<string, unknown>;
      for (const k of ["subjective", "objective", "value", "answer", "result"]) {
        const s = scalar(r[k]);
        if (s !== null) return s;
      }
    }
    if (Array.isArray(v)) return v.map(scalar).filter(Boolean).join(", ") || null;
    return null;
  };
  for (const [category, fields] of Object.entries(input)) {
    const l = leaf(fields);
    if (l !== null) {
      out[category] = l.slice(0, 500);
      continue;
    }
    if (fields && typeof fields === "object" && !Array.isArray(fields)) {
      for (const [field, value] of Object.entries(fields as Record<string, unknown>)) {
        const fl = leaf(value);
        if (fl !== null) out[`${category} · ${field}`] = fl.slice(0, 500);
      }
    }
  }
  return out;
}

const CALLBACK = /\b(call\s?back|call me (back|later|tomorrow)|ring me|phir se call|baad mein call|malli call)\b/i;
const INTEREST =
  /\b(interested|site visit|visit the (site|villa|project)|book(ing)?|schedule|budget|price|pricing|brochure|floor plan|loan|emi|token|when can i|send (me )?details)\b/i;
const NEGATIVE = /\b(not interested|no thanks|wrong number|do not call|don't call|stop calling|remove my number)\b/i;

/**
 * Whether the conversation is worth a lead. Extraction fields win when the
 * agent has them (they are the client's own definition of "qualified"); the
 * caller's words are the fallback. Only the caller's turns are scanned — the
 * agent says "site visit" on every call.
 */
export function detectIntent(input: {
  extracted: Record<string, string>;
  turns: VoiceTurn[];
  transcript: string | null;
}): VoiceCallRecord["intent"] {
  const extractedText = Object.entries(input.extracted)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  if (/callback|call back/i.test(extractedText) && !/callback[^\n]*\b(no|false|none)\b/i.test(extractedText)) {
    return "callback";
  }
  if (/(interest|intent|qualified|outcome|lead)[^\n]*\b(yes|true|high|hot|warm|interested|qualified|positive)\b/i.test(extractedText)) {
    return "interested";
  }
  const callerText = input.turns.length
    ? input.turns.filter((t) => t.role === "caller").map((t) => t.text).join("\n")
    : (input.transcript ?? "");
  if (NEGATIVE.test(callerText)) return "none";
  if (CALLBACK.test(callerText)) return "callback";
  if (INTEREST.test(callerText)) return "interested";
  return "none";
}

/**
 * First extracted value whose key names the *person* — "Lead · Customer Name".
 * Keys like "Project Name" / "Company Name" describe something else and must
 * not become the caller's name (upsertCustomer keeps the first non-blank one).
 */
const NOT_PERSON_NAME = /\b(project|company|builder|agent|business|brand|property|villa|site|product|organi[sz]ation|firm)\b/i;
export function extractedName(extracted: Record<string, string>): string | null {
  for (const [k, v] of Object.entries(extracted)) {
    if (!/\bname\b/i.test(k) || NOT_PERSON_NAME.test(k)) continue;
    if (v && v.length <= 80 && !/^(unknown|n\/a|none|null)$/i.test(v)) return v;
  }
  return null;
}

export function toRecord(execution: BolnaExecution, brandId: string, existing?: VoiceCallRecord): VoiceCallRecord {
  const now = new Date().toISOString();
  const direction: VoiceCallRecord["direction"] =
    execution.callType?.toLowerCase().includes("in") ? "inbound"
    : execution.callType ? "outbound"
    : existing?.direction ?? null;
  const callerPhone = direction === "inbound" ? execution.fromNumber ?? execution.toNumber : execution.toNumber ?? execution.fromNumber;
  // The documented payload is one "assistant: …\nuser: …" string; structured
  // turns win when the provider sent them.
  const turns: VoiceTurn[] = (execution.turns ?? turnsFromText(execution.transcript) ?? []).map((t) => ({
    role: normaliseRole(t.role),
    text: t.text,
  }));
  const extracted = flattenExtracted(execution.extractedData);
  // Bolna posts every status change with no ordering guarantee: once a record
  // is finalised (or already terminal), a late/replayed non-terminal payload
  // must not regress status/duration; only additive fields merge below.
  const locked = Boolean(existing?.finalisedAt) || isTerminal(existing?.status ?? null);
  const status =
    locked && !isTerminal(execution.status) ? existing!.status
    : execution.status ?? existing?.status ?? "unknown";
  const durationSec =
    locked && !isTerminal(execution.status) ? existing!.durationSec
    : execution.durationSeconds ?? existing?.durationSec ?? null;
  const merged = {
    turns: turns.length ? turns : existing?.turns ?? [],
    transcript: execution.transcript ?? existing?.transcript ?? null,
    extracted: Object.keys(extracted).length ? extracted : existing?.extracted ?? {},
  };
  return {
    id: existing?.id ?? uid("vc"),
    brandId: existing?.brandId ?? brandId,
    executionId: execution.id,
    agentId: execution.agentId ?? existing?.agentId ?? null,
    status,
    outcome: outcomeOf(status, durationSec),
    direction,
    from: execution.fromNumber ?? existing?.from ?? null,
    to: execution.toNumber ?? existing?.to ?? null,
    callerPhone: callerPhone ?? existing?.callerPhone ?? null,
    startedAt: existing?.startedAt ?? execution.createdAt ?? now,
    durationSec,
    ...merged,
    summary: execution.summary ?? existing?.summary ?? null,
    recordingUrl: execution.recordingUrl ?? existing?.recordingUrl ?? null,
    cost: execution.cost ?? existing?.cost ?? null,
    customerId: existing?.customerId ?? null,
    leadId: existing?.leadId ?? null,
    leadCreated: existing?.leadCreated ?? false,
    intent: detectIntent(merged),
    finalisedAt: existing?.finalisedAt ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export interface IngestResult {
  record: VoiceCallRecord;
  created: boolean;
  finalised: boolean;
}

/**
 * Upsert the call; on the first terminal status, link the caller to a customer,
 * file the transcript, open a lead when there is intent, and tell sales.
 */
export function ingestExecution(execution: BolnaExecution, ctx: { brandId: string; orgId: string }): IngestResult {
  const before = read().voiceCalls.find((c) => c.executionId === execution.id);
  const record = toRecord(execution, ctx.brandId, before);

  mutate((db) => {
    const i = db.voiceCalls.findIndex((c) => c.executionId === record.executionId);
    if (i === -1) db.voiceCalls.push(record);
    else db.voiceCalls[i] = record;
  });

  // A provider reclassification (no-answer/busy/error -> completed) carries the
  // transcript the first finalisation never saw; run it again for that case only.
  const upgraded = !!record.finalisedAt && before?.outcome !== "completed" && record.outcome === "completed";
  if (!isTerminal(record.status) || (record.finalisedAt && !upgraded)) {
    return { record, created: !before, finalised: false };
  }
  return { record: finalise(record, ctx.orgId), created: !before, finalised: true };
}

function finalise(record: VoiceCallRecord, orgId: string): VoiceCallRecord {
  const now = new Date().toISOString();
  const name = extractedName(record.extracted);
  let customerId: string | null = null;
  let leadId: string | null = null;
  let leadCreated = false;

  const spoke = record.outcome === "completed";
  const wantsLead = spoke && record.intent !== "none";

  if (record.callerPhone) {
    const { customer } = upsertCustomer({
      orgId,
      phone: record.callerPhone,
      name: name ?? undefined,
      source: "voice",
    });
    customerId = customer.id;

    if (spoke) {
      const body =
        record.turns.length
          ? record.turns.map((t) => `${t.role === "agent" ? "Agent" : "Caller"}: ${t.text}`).join("\n")
          : record.transcript ?? record.summary ?? "(no transcript)";
      mutate((db) => {
        // externalId is the execution id: a replay must not file the transcript twice.
        if (db.opsMessages.some((m) => m.externalId === record.executionId)) return;
        db.opsMessages.push({
          id: uid("msg"),
          orgId,
          customerId: customer.id,
          channel: "voice",
          direction: record.direction ?? "outbound",
          body,
          authorType: "ai",
          externalId: record.executionId,
          tag: "voice_transcript",
          meta: { executionId: record.executionId, durationSec: String(record.durationSec ?? 0) },
          createdAt: now,
        });
        const c = db.customers.find((x) => x.id === customer.id);
        if (c) c.lastInteractionAt = now;
      });
    }

    if (wantsLead) {
      const key = normalisePhone(record.callerPhone);
      const existingLead = read().leads.find(
        (l) => l.brandId === record.brandId && normalisePhone(l.phone) === key,
      );
      if (existingLead) {
        leadId = existingLead.id;
      } else {
        const lead: Lead = {
          id: uid("lead"),
          brandId: record.brandId,
          name: name ?? customer.name ?? "Voice caller",
          phone: record.callerPhone,
          city: "",
          status: "new",
          budgetMin: 0,
          budgetMax: 0,
          source: "voice",
          projectInterest: "",
          unitType: "",
          assignedTo: "Unassigned",
          score: 0,
          isHNWI: false,
          kycStatus: "not_started",
          notes: [
            record.intent === "callback" ? "Asked for a callback." : "Showed interest on a voice call.",
            record.summary ?? "",
          ].filter(Boolean).join(" "),
          createdAt: now,
          updatedAt: now,
          tags: ["voice"],
        };
        lead.score = scoreLead(lead);
        mutate((db) => void db.leads.push(lead));
        logActivity(record.brandId, "crm", `New lead from voice agent: ${lead.name}`, "voice-agent");
        leadId = lead.id;
        leadCreated = true;
      }
      mutate((db) => {
        const c = db.customers.find((x) => x.id === customer.id);
        if (c && !c.leadId && leadId) c.leadId = leadId;
      });
    }
  }

  if (spoke || wantsLead) {
    const who = name ?? record.callerPhone ?? "Unknown caller";
    notify({
      orgId,
      recipientRole: "SALES_MANAGER",
      category: "SALES",
      event: leadCreated ? "voice.lead_created" : "voice.call_completed",
      title: leadCreated ? `New lead from voice agent: ${who}` : `Voice call with ${who}`,
      body:
        record.summary ??
        (record.intent === "callback" ? `${who} asked for a callback.`
        : record.intent === "interested" ? `${who} showed interest.`
        : `Call lasted ${Math.round(record.durationSec ?? 0)}s.`),
      customerId: customerId ?? undefined,
      severity: wantsLead ? "WARNING" : "INFO",
    });
  }

  // TODO(notify): src/lib/notify/index.ts is owned by another workstream. When
  // it exposes a voice-lead hook, call it here after the in-app notification.

  const finalised: VoiceCallRecord = { ...record, customerId, leadId, leadCreated, finalisedAt: now, updatedAt: now };
  mutate((db) => {
    const i = db.voiceCalls.findIndex((c) => c.executionId === record.executionId);
    if (i !== -1) db.voiceCalls[i] = finalised;
  });
  return finalised;
}
