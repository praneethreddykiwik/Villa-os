import { db } from "@/lib/osf/supabase";
import { serverClient, supabaseAuthConfigured } from "@/lib/osf/supabase-auth";
import { optional } from "@/lib/osf/env";

/**
 * ROLE-BASED ACCESS CONTROL
 *
 * One rule underpins this file: **the server decides.** A role arriving in a
 * request body, a header, or an AI prompt is ignored. The only thing trusted is
 * the Supabase session cookie, resolved to a villa_team_members row, whose role
 * is then looked up in the villa_role_permissions matrix.
 *
 * That matrix lives in the database rather than in this file so an organisation
 * can add a department without a deploy — see supabase/migrations/004_auth_rbac.sql.
 */

export type Permission =
  | "leads:read" | "leads:write" | "leads:read_all" | "leads:assign"
  | "contacts:read" | "contacts:write" | "walkins:write"
  | "conversations:read" | "conversations:write"
  | "tasks:read" | "tasks:write"
  | "pricing:read" | "pricing:write"
  | "loan:read" | "loan:write"
  | "documents:read" | "documents:download" | "documents:review"
  | "marketing:read" | "marketing:write" | "integrations:write"
  | "construction:read" | "construction:write"
  | "analytics:read" | "analytics:financial"
  | "team:read" | "team:write" | "audit:read" | "settings:write";

export interface Member {
  id: string;
  authUserId: string;
  name: string;
  email: string | null;
  role: string;
  department: string;
  isActive: boolean;
  permissions: Permission[];
}

export class AccessError extends Error {
  constructor(message: string, readonly status: 401 | 403) {
    super(message);
    this.name = "AccessError";
  }
}

/**
 * Which email domains may hold an account.
 *
 * Configuration, not a constant: this application is not built for one company.
 * Empty means "no domain restriction". Set AUTH_ALLOWED_EMAIL_DOMAINS to a
 * comma-separated list, e.g. "example.com,partner.example".
 */
export function allowedEmailDomains(): string[] {
  return (optional("AUTH_ALLOWED_EMAIL_DOMAINS") ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

export function emailDomainAllowed(email: string): boolean {
  const domains = allowedEmailDomains();
  if (!domains.length) return true;
  const domain = email.split("@")[1]?.toLowerCase();
  return Boolean(domain && domains.includes(domain));
}

/* -------------------------------------------------------------------------- */
/* Resolving the caller                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The signed-in member, or null.
 *
 * The auth user is read through the request-scoped client (so the JWT is
 * verified by Supabase), then the member row and permission set are read with
 * the service client. That second read deliberately bypasses RLS: resolving
 * "who is this" cannot itself depend on knowing who this is.
 */
export async function currentMember(): Promise<Member | null> {
  if (!supabaseAuthConfigured()) return null;

  let authUserId: string | null = null;
  let email: string | null = null;
  try {
    const supabase = await serverClient();
    // getUser() validates the JWT with Supabase. getSession() reads the cookie
    // without verifying it and must never be used for an authorisation decision.
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return null;
    authUserId = data.user.id;
    email = data.user.email ?? null;
  } catch {
    return null;
  }

  const { data: row } = await db()
    .from("villa_team_members")
    .select("id, name, email, role, department, is_active, auth_user_id")
    .eq("auth_user_id", authUserId)
    .maybeSingle();

  let member = row as
    | { id: string; name: string; email: string | null; role: string; department: string; is_active: boolean; auth_user_id: string }
    | null;

  // First sign-in for an admin-created Supabase user: link it to the team
  // member that already exists with the same email. Matching on lower(email)
  // mirrors the unique index, so a case difference cannot create a second
  // identity for one person.
  if (!member && email) {
    const { data: byEmail } = await db()
      .from("villa_team_members")
      .select("id, name, email, role, department, is_active, auth_user_id")
      .ilike("email", email)
      .is("auth_user_id", null)
      .maybeSingle();

    if (byEmail) {
      await db().from("villa_team_members").update({ auth_user_id: authUserId }).eq("id", byEmail.id);
      await audit({
        actorId: byEmail.id,
        actorEmail: email,
        action: "auth.account_linked",
        entity: "team_member",
        entityId: byEmail.id,
        metadata: { authUserId },
      });
      member = { ...byEmail, auth_user_id: authUserId };
    }
  }

  // Authenticated with Supabase but not on the team, or disabled. Both are a
  // "no", and both are reported the same way to the caller.
  if (!member || !member.is_active) return null;

  const { data: perms } = await db()
    .from("villa_role_permissions")
    .select("permission_key")
    .eq("role", member.role)
    .eq("allowed", true);

  return {
    id: member.id,
    authUserId: authUserId!,
    name: member.name,
    email: member.email,
    role: member.role,
    department: member.department,
    isActive: member.is_active,
    permissions: (perms ?? []).map((p) => p.permission_key as Permission),
  };
}

export function can(member: Member | null, permission: Permission): boolean {
  return Boolean(member?.permissions.includes(permission));
}

export function canAny(member: Member | null, permissions: Permission[]): boolean {
  return permissions.some((p) => can(member, p));
}

/**
 * The guard every protected route calls. Throws rather than returning a
 * boolean, so a forgotten `if` cannot silently grant access.
 */
export async function requirePermission(...permissions: Permission[]): Promise<Member> {
  const member = await currentMember();
  if (!member) throw new AccessError("Sign in required", 401);
  for (const permission of permissions) {
    if (!can(member, permission)) {
      throw new AccessError(`Your role does not include ${permission}`, 403);
    }
  }
  return member;
}

export async function requireMember(): Promise<Member> {
  const member = await currentMember();
  if (!member) throw new AccessError("Sign in required", 401);
  return member;
}

/* -------------------------------------------------------------------------- */
/* Audit                                                                       */
/* -------------------------------------------------------------------------- */

export interface AuditInput {
  actorId?: string | null;
  actorEmail?: string | null;
  actorType?: "human" | "ai" | "system" | "customer";
  action: string;
  entity: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Append an audit row. Never throws: an audit write failing must not roll back
 * the business action that succeeded, but it must be visible in the logs.
 */
export async function audit(input: AuditInput): Promise<void> {
  try {
    await db().from("villa_audit_log").insert({
      actor_id: input.actorId ?? null,
      actor_email: input.actorEmail ?? null,
      actor_type: input.actorType ?? "human",
      action: input.action,
      entity: input.entity,
      entity_id: input.entityId ?? null,
      metadata: input.metadata ?? {},
      ip: input.ip ?? null,
    });
  } catch (error) {
    console.error("[audit] failed to record", input.action, error);
  }
}

/* -------------------------------------------------------------------------- */
/* Route → permission map                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Which permission a top-level area requires. The middleware uses this for a
 * coarse first cut; every route still performs its own check, because a
 * middleware match is a convenience and not a security boundary.
 */
export const AREA_PERMISSIONS: Array<{ prefix: string; permission: Permission }> = [
  { prefix: "/team", permission: "team:read" },
  { prefix: "/admin", permission: "settings:write" },
  { prefix: "/inbox/whatsapp/analytics", permission: "analytics:read" },
  { prefix: "/inbox/whatsapp/marketing", permission: "marketing:read" },
  { prefix: "/construction", permission: "construction:read" },
  { prefix: "/loans", permission: "loan:read" },
  { prefix: "/audit", permission: "audit:read" },
];

export function permissionForPath(pathname: string): Permission | null {
  const match = AREA_PERMISSIONS.find(
    (entry) => pathname === entry.prefix || pathname.startsWith(`${entry.prefix}/`),
  );
  return match?.permission ?? null;
}

/** Human-readable role label, used in the UI. */
export function roleLabel(role: string): string {
  return role
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/* -------------------------------------------------------------------------- */
/* Live matrix — what is actually enforced                                     */
/* -------------------------------------------------------------------------- */

export interface PermissionCatalogueEntry {
  key: Permission;
  label: string;
  description: string;
  category: string;
}

export interface LiveMatrix {
  permissions: PermissionCatalogueEntry[];
  /** role -> set of granted permission keys */
  byRole: Record<string, string[]>;
  roles: string[];
}

/**
 * Read the enforced role/permission matrix.
 *
 * This is the same table villa_can() consults inside Postgres, so what an admin
 * sees on screen is what the database will actually allow. src/lib/settings.ts
 * carries a separate ROLE_MATRIX constant that predates access control — that
 * one is descriptive documentation and enforces nothing; this one is the rule.
 */
export async function liveMatrix(): Promise<LiveMatrix> {
  const [{ data: catalogue }, { data: grants }, { data: mentioned }, { data: staffed }] = await Promise.all([
    db().from("villa_permissions").select("key, label, description, category").order("category").order("key"),
    db().from("villa_role_permissions").select("role, permission_key").eq("allowed", true),
    // Every role the table knows about, including the ones whose rows are all
    // allowed = false.
    db().from("villa_role_permissions").select("role"),
    db().from("villa_team_members").select("role"),
  ]);

  const byRole: Record<string, string[]> = {};
  for (const row of (grants ?? []) as Array<{ role: string; permission_key: string }>) {
    (byRole[row.role] ??= []).push(row.permission_key);
  }

  /**
   * The roles are deliberately NOT the keys of `byRole`.
   *
   * A revoke is an upsert of allowed = false, not a delete, so a role whose
   * last capability is removed still exists — but it would vanish from a list
   * built only from granted rows. On the Control Centre that means the chip
   * disappears mid-edit and there is no longer any way to grant the role
   * anything back: the screen has locked itself out of its own subject. The
   * same omission hides a freshly created role that has not been given
   * anything yet, which is exactly the state a person is in when they come
   * here to set one up.
   */
  const roles = new Set<string>(Object.keys(byRole));
  for (const row of [...((mentioned ?? []) as Array<{ role: string }>), ...((staffed ?? []) as Array<{ role: string }>)]) {
    if (typeof row.role === "string" && row.role.trim()) roles.add(row.role);
  }

  return {
    permissions: (catalogue ?? []) as PermissionCatalogueEntry[],
    byRole,
    roles: [...roles].sort(),
  };
}

/** Grant or revoke one capability for one role. Takes effect immediately. */
export async function setRolePermission(
  role: string,
  permission: string,
  allowed: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await db()
    .from("villa_role_permissions")
    .upsert({ role, permission_key: permission, allowed, updated_at: new Date().toISOString() }, {
      onConflict: "role,permission_key",
    });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Members with their sign-in status, for the access-management screen. */
export interface MemberAccount {
  id: string;
  name: string;
  email: string | null;
  role: string;
  department: string;
  isActive: boolean;
  hasLogin: boolean;
  lastLoginAt: string | null;
  permissionCount: number;
}

export async function listMemberAccounts(): Promise<MemberAccount[]> {
  const [{ data: members }, matrix] = await Promise.all([
    db()
      .from("villa_team_members")
      .select("id, name, email, role, department, is_active, auth_user_id, last_login_at")
      .order("is_active", { ascending: false })
      .order("name"),
    liveMatrix(),
  ]);

  return ((members ?? []) as Array<Record<string, unknown>>).map((m) => ({
    id: String(m.id),
    name: String(m.name ?? ""),
    email: (m.email as string | null) ?? null,
    role: String(m.role ?? ""),
    department: String(m.department ?? ""),
    isActive: Boolean(m.is_active),
    hasLogin: Boolean(m.auth_user_id),
    lastLoginAt: (m.last_login_at as string | null) ?? null,
    permissionCount: (matrix.byRole[String(m.role ?? "")] ?? []).length,
  }));
}
