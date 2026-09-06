import { read } from "../db";
import { normalisePhone } from "../ops/customers";
import { defaultOrgId } from "../ops/seed";
import {
  checkBolnaStatus, configuredAgentId, getAccount, isConfigured, listAgents, listExecutions,
} from "../bolna/client";
import { ingestExecution } from "./calls";
import type { VoiceCallRecord } from "./types";

/**
 * WHAT THE CLIENT SEES — assembled once, used by the page and by /api/voice.
 *
 * The client view is derived from `db.voiceCalls` only. The provider is
 * consulted just to backfill calls the webhook never delivered (it is
 * optional in local setups), and everything it says goes through the same
 * ingestion path, so a backfilled call and a webhooked call look identical.
 * Cost and vendor names never enter `VoiceClientCall`.
 */

export interface VoiceClientCall extends Omit<VoiceCallRecord, "cost" | "agentId"> {
  leadName: string | null;
  customerName: string | null;
}

export interface VoiceFunnel {
  calls: number;
  answered: number;
  leads: number;
  siteVisits: number;
}

export interface VoiceDiagnostics {
  provider: "Bolna";
  apiKey: boolean;
  agentId: string | null;
  status: string;
  agentCount: number | null;
  balance: string | null;
  spend: number | null;
  webhookSecret: boolean;
  problems: string[];
}

export interface VoiceOverview {
  brandId: string;
  days: number;
  /** True when the live agent is connected; false = local log only. */
  connected: boolean;
  calls: VoiceClientCall[];
  funnel: VoiceFunnel;
  /** Only present for users.manage. */
  diagnostics?: VoiceDiagnostics;
}

const MAX_CALLS = 200;
const MAX_AGENTS_QUERIED = 4;
const FUNNEL_VISIT_STATUSES = new Set(["site_visit_scheduled", "negotiation", "booking_token_paid", "won"]);

/**
 * Pull the provider's history for calls we have not seen. Bounded to a few
 * agents and tolerant of every failure: the client view must render from the
 * local log even when the provider is down.
 */
async function backfill(brandId: string): Promise<string[]> {
  const problems: string[] = [];
  const pinned = configuredAgentId();
  let agentIds: string[] = pinned ? [pinned] : [];
  if (!agentIds.length) {
    const agents = await listAgents();
    if (!agents.ok) return [`Could not list agents: ${agents.error}`];
    agentIds = agents.data.slice(0, MAX_AGENTS_QUERIED).map((a) => a.id);
  }
  const orgId = defaultOrgId();
  const results = await Promise.all(agentIds.map((id) => listExecutions(id).then((r) => [id, r] as const)));
  for (const [id, r] of results) {
    if (!r.ok) {
      problems.push(`Could not load history for agent ${id}: ${r.error}`);
      continue;
    }
    const known = new Set(read().voiceCalls.map((c) => c.executionId));
    for (const execution of r.data) {
      // Non-terminal executions are re-ingested so a call in progress at the
      // last backfill picks up its final status on the next one.
      const existing = known.has(execution.id) ? read().voiceCalls.find((c) => c.executionId === execution.id) : undefined;
      if (existing?.finalisedAt) continue;
      try {
        ingestExecution(execution, { brandId, orgId });
      } catch (e) {
        problems.push(`Could not ingest call ${execution.id}: ${(e as Error).message}`);
      }
    }
  }
  return problems;
}

const overviewCache = new Map<string, { at: number; data: VoiceOverview }>();
const OVERVIEW_CACHE_TTL = 60_000;

export async function loadVoiceOverview(
  brandId: string,
  opts: { days: number; diagnostics: boolean },
): Promise<VoiceOverview> {
  const cacheKey = `${brandId}:${opts.days}:${opts.diagnostics}`;
  const hit = overviewCache.get(cacheKey);
  if (hit && Date.now() - hit.at < OVERVIEW_CACHE_TTL) {
    return hit.data;
  }

  const connected = isConfigured();
  const problems = connected ? await backfill(brandId) : [];

  const db = read();
  const since = Date.now() - opts.days * 86_400_000;
  const leadsById = new Map(db.leads.map((l) => [l.id, l] as const));
  const customersById = new Map(db.customers.map((c) => [c.id, c] as const));

  const calls: VoiceClientCall[] = db.voiceCalls
    .filter((c) => c.brandId === brandId && new Date(c.startedAt).getTime() >= since)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, MAX_CALLS)
    .map(({ cost: _cost, agentId: _agentId, ...c }) => ({
      ...c,
      leadName: c.leadId ? leadsById.get(c.leadId)?.name ?? null : null,
      customerName: c.customerId ? customersById.get(c.customerId)?.name ?? null : null,
    }));

  // A site visit counts when the lead the call produced has moved to (or past)
  // the visit stage, or an appointment exists for the caller's number after
  // the call. Both are the client's own records, not a provider's guess.
  const callerKeys = new Set(calls.map((c) => (c.callerPhone ? normalisePhone(c.callerPhone) : "")).filter(Boolean));
  const leadIds = new Set(calls.map((c) => c.leadId).filter((id): id is string => Boolean(id)));
  const visitLeads = [...leadIds].filter((id) => {
    const l = leadsById.get(id);
    return l && (FUNNEL_VISIT_STATUSES.has(l.status) || Boolean(l.siteVisitAt));
  });
  const visitAppointments = db.appointments.filter(
    (a) => a.brandId === brandId && a.status !== "cancelled" && callerKeys.has(normalisePhone(a.customerPhone)) &&
      new Date(a.createdAt ?? a.startsAt).getTime() >= since && !(a.leadId && leadIds.has(a.leadId)),
  );

  const overview: VoiceOverview = {
    brandId,
    days: opts.days,
    connected,
    calls,
    funnel: {
      calls: calls.length,
      answered: calls.filter((c) => c.outcome === "completed").length,
      leads: leadIds.size,
      siteVisits: visitLeads.length + visitAppointments.length,
    },
  };

  if (opts.diagnostics) {
    const [status, account] = connected ? await Promise.all([checkBolnaStatus(), getAccount()]) : [null, null];
    const spend = db.voiceCalls
      .filter((c) => c.brandId === brandId && c.cost !== null)
      .reduce((s, c) => s + (c.cost ?? 0), 0);
    if (account && !account.ok) problems.push(`Account: ${account.error}`);
    overview.diagnostics = {
      provider: "Bolna",
      apiKey: connected,
      agentId: configuredAgentId(),
      status: status?.message ?? "BOLNA_API_KEY is not set",
      agentCount: status?.agentCount ?? null,
      balance: account?.ok && account.data?.balance !== null && account.data
        ? `${account.data.balance} ${account.data.currency ?? ""}`.trim()
        : null,
      spend: db.voiceCalls.some((c) => c.brandId === brandId && c.cost !== null) ? spend : null,
      webhookSecret: Boolean(process.env.VOICE_WEBHOOK_SECRET),
      problems,
    };
  }

  overviewCache.set(cacheKey, { at: Date.now(), data: overview });
  return overview;
}
