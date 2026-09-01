import { mutate, read } from "../db";
import { uid } from "../ids";
import { defaultConfig } from "./config";
import type { LoanRule, TeamMember } from "./types";

/**
 * Ops bootstrap.
 *
 * Creates the team, the default workflow config and a starter set of
 * loan-analysis rules for an org. Deliberately does NOT fabricate customers or
 * loan cases: this workflow handles real people's financial documents, and
 * seeding fake applications into it would make the dashboards lie about what
 * work actually exists. Customers arrive through the WhatsApp webhook, and the
 * test harness drives the full lifecycle explicitly.
 */

const TEAM: Array<Pick<TeamMember, "name" | "email" | "role" | "capacity">> = [
  { name: "Team Admin", email: "admin@example.com", role: "ADMIN", capacity: 999 },
  { name: "Sales Manager 1", email: "sales1@example.com", role: "SALES_MANAGER", capacity: 25 },
  { name: "Sales Manager 2", email: "sales2@example.com", role: "SALES_MANAGER", capacity: 25 },
  { name: "Sales Manager 3", email: "sales3@example.com", role: "SALES_MANAGER", capacity: 25 },
  { name: "Loan Officer 1", email: "loan1@example.com", role: "LOAN_OFFICER", capacity: 20 },
  { name: "Loan Officer 2", email: "loan2@example.com", role: "LOAN_OFFICER", capacity: 20 },
  { name: "Loan Officer 3", email: "loan3@example.com", role: "LOAN_OFFICER", capacity: 20 },
];

const STARTER_RULES: Array<Omit<LoanRule, "id" | "orgId" | "createdAt">> = [
  { label: "Minimum declared income", kind: "MIN_INCOME", operator: "gte", value: "0", severity: "BLOCKING", enabled: false, notes: "Set a real threshold before enabling." },
  { label: "Maximum loan amount", kind: "MAX_LOAN_AMOUNT", operator: "lte", value: "0", severity: "BLOCKING", enabled: false, notes: "Set a real ceiling before enabling." },
  { label: "Minimum employment duration (months)", kind: "MIN_EMPLOYMENT_MONTHS", operator: "gte", value: "12", severity: "WARNING", enabled: false },
  { label: "Maximum debt-to-income ratio", kind: "MAX_DTI", operator: "lte", value: "0.5", severity: "WARNING", enabled: false },
];

/** Idempotent: safe to call on every boot. */
export function ensureOpsSeed(orgId: string): { created: boolean; members: TeamMember[] } {
  const db = read();
  const existing = db.teamMembers.filter((m) => m.orgId === orgId);
  if (existing.length) return { created: false, members: existing };

  const now = new Date().toISOString();
  const members: TeamMember[] = TEAM.map((t) => ({
    id: uid("mem"),
    orgId,
    name: t.name,
    email: t.email,
    role: t.role,
    active: true,
    capacity: t.capacity,
    createdAt: now,
  }));

  mutate((d) => {
    d.teamMembers.push(...members);
    if (!d.workflowConfigs.some((c) => c.orgId === orgId)) d.workflowConfigs.push(defaultConfig(orgId));
    if (!d.loanRules.some((r) => r.orgId === orgId)) {
      d.loanRules.push(...STARTER_RULES.map((r) => ({ ...r, id: uid("lrl"), orgId, createdAt: now })));
    }
  });

  return { created: true, members };
}

/** The org is the workspace — one tenant boundary, reused from the existing model. */
export function defaultOrgId(): string {
  return read().workspaces[0]?.id ?? "ws_default";
}
