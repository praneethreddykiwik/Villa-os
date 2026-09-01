import { mutate, read } from "../db";
import { uid } from "../ids";
import { defaultConfig } from "./config";
import type { LoanRule, TeamMember } from "./types";

/**
 * Ops bootstrap.
 *
 * Creates the default workflow config and a starter set of loan-analysis rules
 * for an org; the team roster is no longer part of it (see `ensureOpsSeed`).
 * Deliberately does NOT fabricate customers or loan cases: this workflow handles
 * real people's financial documents, and seeding fake applications into it would
 * make the dashboards lie about what work actually exists. Customers arrive
 * through the WhatsApp webhook, and the test harness drives the full lifecycle
 * explicitly.
 */

const STARTER_RULES: Array<Omit<LoanRule, "id" | "orgId" | "createdAt">> = [
  { label: "Minimum declared income", kind: "MIN_INCOME", operator: "gte", value: "0", severity: "BLOCKING", enabled: false, notes: "Set a real threshold before enabling." },
  { label: "Maximum loan amount", kind: "MAX_LOAN_AMOUNT", operator: "lte", value: "0", severity: "BLOCKING", enabled: false, notes: "Set a real ceiling before enabling." },
  { label: "Minimum employment duration (months)", kind: "MIN_EMPLOYMENT_MONTHS", operator: "gte", value: "0", severity: "WARNING", enabled: false, notes: "Set a real minimum before enabling." },
  { label: "Maximum debt-to-income ratio", kind: "MAX_DTI", operator: "lte", value: "0.5", severity: "WARNING", enabled: false },
];

/**
 * Idempotent: safe to call on every boot.
 *
 * Creates the org's workflow configuration and its (disabled) starter loan
 * rules. It no longer fabricates a team roster — staff are real Supabase Auth
 * users provisioned by `npm run provision-users`, and a second, invented roster
 * in the JSON store made the assignment dashboards count people who do not
 * exist.
 */
export function ensureOpsSeed(orgId: string): { created: boolean; members: TeamMember[] } {
  const db = read();
  const members = db.teamMembers.filter((m) => m.orgId === orgId);

  const hasConfig = db.workflowConfigs.some((c) => c.orgId === orgId);
  const hasRules = db.loanRules.some((r) => r.orgId === orgId);
  if (hasConfig && hasRules) return { created: false, members };

  const now = new Date().toISOString();
  mutate((d) => {
    if (!d.workflowConfigs.some((c) => c.orgId === orgId)) d.workflowConfigs.push(defaultConfig(orgId));
    if (!d.loanRules.some((r) => r.orgId === orgId)) {
      d.loanRules.push(...STARTER_RULES.map((r) => ({ ...r, id: uid("lrl"), orgId, createdAt: now })));
    }
  });

  return { created: true, members };
}

export function defaultOrgId(): string {
  return read().workspaces[0]?.id ?? "ws_default";
}
