import { mutate, read } from "../db";
import { uid } from "../ids";
import { adminClient, hasServiceRole, isSupabaseConfigured } from "../supabase/client";
import { defaultConfig } from "./config";
import type { LoanRule, Role, TeamMember } from "./types";

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

let orgIdCache: { id: string; at: number } | null = null;

/**
 * The org that server-to-server callers (the WhatsApp webhook, the follow-up
 * cron) act for.
 *
 * Signed-in sessions carry the Supabase `organizations.id`, and every ops
 * query is scoped to it. `defaultOrgId()` returns the local workspace id, which
 * is a different string — so a customer the webhook created under it was
 * invisible to every dashboard and could never be assigned. When Supabase is
 * configured the organisation row is the source of truth; the workspace id
 * remains the fallback for the local/mock store the tests run against.
 */
export async function resolveDefaultOrgId(): Promise<string> {
  if (!isSupabaseConfigured() || !hasServiceRole()) return defaultOrgId();
  if (orgIdCache && Date.now() - orgIdCache.at < 5 * 60_000) return orgIdCache.id;
  try {
    const { data } = await adminClient()
      .from("organizations")
      .select("id")
      .eq("active", true)
      .order("created_at")
      .limit(1)
      .maybeSingle();
    if (data?.id) {
      orgIdCache = { id: data.id, at: Date.now() };
      return data.id;
    }
  } catch {
    /* fall through to the local id */
  }
  return defaultOrgId();
}

const SUPABASE_ROLE_TO_OPS: Record<string, Role> = {
  sales: "SALES_MANAGER",
  loan: "LOAN_OFFICER",
  admin: "ADMIN",
};

const teamSyncedAt = new Map<string, number>();

/**
 * Mirror Supabase staff into the roster the assignment engine reads.
 *
 * `assign()` picks from `teamMembers`, but staff live in Supabase `profiles`
 * and `user_roles`; without this mirror the roster is empty and every lead
 * stays unassigned. Member ids are the profile ids, so `assignedSalesManagerId`
 * compares equal to the signed-in `memberId` in the sales workspace filter.
 * Throttled to once a minute per org; failures keep the last known roster.
 */
export async function syncTeamMembers(orgId: string): Promise<TeamMember[]> {
  const current = () => read().teamMembers.filter((m) => m.orgId === orgId);
  if (!isSupabaseConfigured() || !hasServiceRole()) return current();
  const last = teamSyncedAt.get(orgId) ?? 0;
  if (Date.now() - last < 60_000) return current();

  try {
    const { data, error } = await adminClient()
      .from("profiles")
      .select("id, full_name, email, active, capacity, created_at, user_roles!user_roles_profile_id_fkey(roles(key))")
      .eq("org_id", orgId);
    if (error) throw error;

    type Row = {
      id: string;
      full_name: string;
      email: string;
      active: boolean;
      capacity: number;
      created_at: string;
      user_roles: Array<{ roles: { key: string } | { key: string }[] | null }> | null;
    };
    const rows = (data ?? []) as unknown as Row[];
    const seen = new Set<string>();
    const incoming: TeamMember[] = [];
    for (const r of rows) {
      const keys = (r.user_roles ?? []).flatMap((ur) => (Array.isArray(ur.roles) ? ur.roles : ur.roles ? [ur.roles] : [])).map((x) => x.key);
      // Sales and loan grants decide the queue; admin only counts when it is the
      // person's sole role, so an admin who also sells is picked as sales.
      const role = keys.map((k) => SUPABASE_ROLE_TO_OPS[k]).find((x) => x && x !== "ADMIN") ?? (keys.includes("admin") ? "ADMIN" : undefined);
      if (!role) continue;
      seen.add(r.id);
      incoming.push({
        id: r.id,
        orgId,
        name: r.full_name || r.email,
        email: r.email,
        role,
        active: r.active,
        capacity: r.capacity > 0 ? r.capacity : 20,
        createdAt: r.created_at,
      });
    }

    mutate((d) => {
      const byId = new Map(d.teamMembers.filter((m) => m.orgId === orgId).map((m) => [m.id, m]));
      for (const m of incoming) {
        const existing = byId.get(m.id);
        if (existing) Object.assign(existing, m, { lastLoginAt: existing.lastLoginAt });
        else d.teamMembers.push(m);
      }
      // A profile that lost its ops role, or was deleted, must stop receiving work.
      for (const m of d.teamMembers) {
        if (m.orgId === orgId && !seen.has(m.id)) m.active = false;
      }
    });
    teamSyncedAt.set(orgId, Date.now());
  } catch {
    /* keep the last known roster */
  }
  return current();
}
