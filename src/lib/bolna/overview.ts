import { read } from "../db";
import { normalisePhone } from "../ops/customers";
import {
  getAccount, isConfigured, listAgents, listExecutions,
  type BolnaAccount, type BolnaAgent, type BolnaExecution, type BolnaFailure,
} from "./client";

/**
 * WHAT THE VOICE TAB SHOWS — assembled once, used twice.
 *
 * The page renders this on the server and the panel re-fetches it through
 * /api/voice, so both have to agree about what "the voice tab" contains. Doing
 * the assembly in one place is what stops the refreshed view from quietly
 * differing from the first paint.
 */

export interface VoiceLead {
  id: string;
  name: string;
  phone: string;
}

export interface VoiceCall extends BolnaExecution {
  agentName: string | null;
  leadId: string | null;
  leadName: string | null;
}

export interface VoiceOverview {
  configured: boolean;
  agents: BolnaAgent[];
  calls: VoiceCall[];
  account: BolnaAccount | null;
  /** Leads that can be dialled — brand-scoped, with a phone number on file. */
  leads: VoiceLead[];
  /**
   * Provider-side failures, in the provider's own words. Carried alongside the
   * data rather than thrown, so one agent's history failing does not blank the
   * other agent's, and so the operator can see *why* something is missing
   * instead of guessing at an empty table.
   */
  problems: string[];
}

/**
 * How many agents we will pull history for on one page load.
 *
 * Each is a separate round trip. An account that grows to fifty agents would
 * otherwise turn one page render into fifty sequential-ish provider calls and
 * blow the request budget; the tab is for running a handful of agents.
 */
const MAX_AGENTS_QUERIED = 8;

/** Newest calls only — the table is a recent-activity view, not an archive. */
const MAX_CALLS = 60;

function describe(failure: BolnaFailure, what: string): string {
  return `${what}: ${failure.error}`;
}

/** Newest first, with undated rows last rather than sorted to the top. */
function byNewest(a: VoiceCall, b: VoiceCall): number {
  if (!a.createdAt) return 1;
  if (!b.createdAt) return -1;
  return b.createdAt.localeCompare(a.createdAt);
}

export async function loadVoiceOverview(brandId: string): Promise<VoiceOverview> {
  const db = read();
  const leads: VoiceLead[] = db.leads
    .filter((l) => l.brandId === brandId && l.phone.trim())
    .map((l) => ({ id: l.id, name: l.name, phone: l.phone }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!isConfigured()) {
    return { configured: false, agents: [], calls: [], account: null, leads, problems: [] };
  }

  const problems: string[] = [];

  const agentsResult = await listAgents();
  if (!agentsResult.ok) {
    problems.push(describe(agentsResult, "Could not list agents"));
    return { configured: true, agents: [], calls: [], account: null, leads, problems };
  }
  const agents = agentsResult.data;

  // Independent per-agent histories plus the account probe, all in flight at
  // once — sequentially they would add a full round trip per agent to a render
  // somebody is waiting on.
  const [historyResults, accountResult] = await Promise.all([
    Promise.all(agents.slice(0, MAX_AGENTS_QUERIED).map((a) => listExecutions(a.id).then((r) => [a, r] as const))),
    getAccount(),
  ]);

  if (!accountResult.ok) problems.push(describe(accountResult, "Could not read account details"));

  /**
   * Phone → lead, using the CRM's own normalisation and nothing else.
   *
   * The match is exact on the normalised key. That means a lead stored as
   * "9876543210" will not match a call dialled to "+919876543210", because
   * `normalisePhone` keeps the country code where one was typed. That is the
   * correct behaviour to have here: inventing a second, looser rule (suffix
   * matching, say) would let two different subscribers in two countries collide
   * onto one lead. If the CRM's numbers need country codes, that belongs in
   * `normalisePhone` and the lead records, not in a private rule in this file.
   */
  const byPhone = new Map<string, VoiceLead>();
  for (const lead of leads) {
    const key = normalisePhone(lead.phone);
    if (key && !byPhone.has(key)) byPhone.set(key, lead);
  }

  const calls: VoiceCall[] = [];
  for (const [agent, result] of historyResults) {
    if (!result.ok) {
      problems.push(describe(result, `Could not load call history for ${agent.name}`));
      continue;
    }
    for (const execution of result.data) {
      const lead = execution.toNumber ? byPhone.get(normalisePhone(execution.toNumber)) : undefined;
      calls.push({
        ...execution,
        agentName: agent.name,
        leadId: lead?.id ?? null,
        leadName: lead?.name ?? null,
      });
    }
  }

  if (agents.length > MAX_AGENTS_QUERIED) {
    problems.push(
      `Call history was loaded for the first ${MAX_AGENTS_QUERIED} of ${agents.length} agents. The rest are listed above without their calls.`,
    );
  }

  return {
    configured: true,
    agents,
    calls: calls.sort(byNewest).slice(0, MAX_CALLS),
    account: accountResult.ok ? accountResult.data : null,
    leads,
    problems,
  };
}
