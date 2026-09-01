import {
  AuthError as CoreAuthError, getSession, requirePermission,
  assertCustomerAccess as coreAssertCustomerAccess, type Permission as CorePermission, type Session as CoreSession,
} from "../auth/session";

/**
 * Adapter from the ops module's permission vocabulary onto the single
 * Supabase-backed authorisation system.
 *
 * The ops layer was written against a local session store with colon-separated
 * permission names. That store is gone — Supabase Auth plus the `role_permissions`
 * table is now the only source of truth. Rather than rename twenty call sites in
 * one pass, this maps the old names onto the real ones so every existing route
 * is enforced against real roles today.
 */

export type { CoreSession as Session };
export const AuthError = CoreAuthError;

/** Old name → the permission actually granted in the database. */
const MAP: Record<string, CorePermission> = {
  "customer:read": "customers.read",
  "customer:write": "customers.write",
  "sales:read": "sales.read",
  "sales:write": "sales.write",
  "loan:read": "loans.read",
  "loan:write": "loans.write",
  "document:read": "documents.read",
  "document:download": "documents.read",
  "document:review": "documents.verify",
  "admin:read": "analytics.view",
  "admin:write": "users.manage",
  "config:write": "workflows.manage",
  "audit:read": "audit.view",
};

export type Permission = keyof typeof MAP;

function translate(p: string): CorePermission {
  const mapped = MAP[p];
  if (!mapped) throw new CoreAuthError(`Unknown permission: ${p}`, 403);
  return mapped;
}

/** Session shape the ops pages expect, projected from the real session. */
export interface OpsSession {
  memberId: string;
  orgId: string;
  role: "ADMIN" | "SALES_MANAGER" | "LOAN_OFFICER" | "NONE";
  name: string;
  permissions: Set<CorePermission>;
}

function project(s: CoreSession): OpsSession {
  // Display label only. It used to default to SALES_MANAGER for any unknown
  // role, which meant a front-desk account was treated as sales by pages that
  // branched on the label. Now it defaults to the least privileged value and
  // every real decision is made against the permission set.
  const role = s.roles.includes("admin")
    ? "ADMIN"
    : s.roles.includes("loan")
      ? "LOAN_OFFICER"
      : s.permissions.has("sales.write")
        ? "SALES_MANAGER"
        : "NONE";
  return { memberId: s.userId, orgId: s.orgId, role, name: s.fullName, permissions: s.permissions };
}

export async function authorize(_req: Request, ...required: string[]): Promise<OpsSession> {
  const session = await requirePermission(...required.map(translate));
  return project(session);
}

export async function sessionFromCookies(): Promise<OpsSession | null> {
  const s = await getSession();
  return s ? project(s) : null;
}

export function can(session: OpsSession | null, permission: string): boolean {
  if (!session) return false;
  const mapped = MAP[permission];
  return Boolean(mapped && session.permissions.has(mapped));
}

export function permissionsFor(_role: string): string[] {
  // Permissions come from the database now, not from a hardcoded role table.
  return [];
}

export async function assertCustomerAccess(session: OpsSession, customerId: string): Promise<void> {
  await coreAssertCustomerAccess(
    { userId: session.memberId, orgId: session.orgId, permissions: session.permissions, email: "", fullName: session.name, roles: [], mustChangePassword: false },
    customerId,
  );
}

/** Async because ownership lives in the database, not in the session. */
export async function canAccessCustomer(session: OpsSession, customerId: string): Promise<boolean> {
  try {
    await assertCustomerAccess(session, customerId);
    return true;
  } catch {
    return false;
  }
}
