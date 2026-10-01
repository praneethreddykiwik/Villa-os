import "server-only";
import { adminClient } from "@/lib/supabase/client";
import { PERMISSIONS, type Permission } from "@/lib/auth/session";

/**
 * ACCESS CONTROL, AGAINST THE TABLES THAT ACTUALLY DECIDE IT.
 *
 * `src/lib/auth/session.ts` builds every session's permission set from exactly
 * one place: user_roles -> roles -> role_permissions. The layout gate and every
 * `guard()` in the API then read that set. So those three tables are what
 * "access" means in this application.
 *
 * This module exists because the control centre used to edit a different set —
 * villa_role_permissions, keyed by a different list of roles (sales_agent,
 * marketing_manager, viewer …) under a different naming scheme (leads:read
 * rather than sales.read). Nothing in the request path has ever read it. Every
 * toggle on that screen wrote successfully to a table that changes nothing,
 * which is why revoking a capability appeared to do nothing at all.
 *
 * villa_role_permissions is not deleted here: it still backs the villa_can()
 * checks inside Postgres. But it is not what gates a page or an endpoint, so it
 * is not what the control centre edits.
 */

/** Roles that cannot be edited, because they are the way back in. */
export const PROTECTED_ROLES = ["admin"] as const;

export function isProtectedRole(key: string): boolean {
  return (PROTECTED_ROLES as readonly string[]).includes(key);
}

export interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
}

export interface AccessMatrix {
  roles: RoleRow[];
  /** role key -> the permissions it grants */
  byRole: Record<string, Permission[]>;
}

function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}

/** Every role, and what each one currently grants. */
export async function accessMatrix(): Promise<AccessMatrix> {
  const sb = adminClient();
  const [rolesRes, grantRes] = await Promise.all([
    sb.from("roles").select("id, key, name, description").order("key"),
    sb.from("role_permissions").select("role_id, permission_key"),
  ]);

  const roles = (rolesRes.data ?? []) as RoleRow[];
  const keyById = new Map(roles.map((r) => [r.id, r.key]));

  // Seeded from the role list, not from the grants, so a role holding nothing
  // still appears. Deriving it from the grants would make a role vanish the
  // moment its last capability was removed — and with it the only way to give
  // anything back.
  const byRole: Record<string, Permission[]> = {};
  for (const role of roles) byRole[role.key] = [];

  for (const row of (grantRes.data ?? []) as Array<{ role_id: string; permission_key: string }>) {
    const key = keyById.get(row.role_id);
    // A grant naming a permission the application no longer defines is stale
    // configuration; showing it would invite someone to "fix" a row that
    // nothing reads.
    if (key && isPermission(row.permission_key)) byRole[key].push(row.permission_key);
  }

  return { roles, byRole };
}

/**
 * Grant or revoke one capability for one role.
 *
 * role_permissions has no `allowed` column — a grant is the row's presence. So
 * revoking deletes rather than writing false, and granting is an upsert so a
 * double click cannot raise a duplicate-key error.
 */
export async function setRolePermission(
  roleKey: string,
  permission: Permission,
  allowed: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = adminClient();

  const { data: role, error: roleError } = await sb
    .from("roles")
    .select("id")
    .eq("key", roleKey)
    .maybeSingle();
  if (roleError) return { ok: false, error: roleError.message };
  if (!role) return { ok: false, error: `There is no role called ${roleKey}.` };

  if (allowed) {
    const { error } = await sb
      .from("role_permissions")
      .upsert({ role_id: role.id, permission_key: permission }, { onConflict: "role_id,permission_key" });
    return error ? { ok: false, error: error.message } : { ok: true };
  }

  const { error } = await sb
    .from("role_permissions")
    .delete()
    .eq("role_id", role.id)
    .eq("permission_key", permission);
  return error ? { ok: false, error: error.message } : { ok: true };
}

export interface AccountRow {
  id: string;
  email: string;
  fullName: string;
  role: string | null;
  active: boolean;
  lastLoginAt: string | null;
}

/**
 * The accounts that can actually sign in, with the role that decides what they
 * see.
 *
 * Deliberately `profiles` joined to `user_roles`, not villa_team_members: the
 * latter lists a different set of people under role names this application does
 * not resolve, so a screen built from it answers "who is on the team" with
 * names that have no bearing on who can open anything.
 */
export async function listAccounts(): Promise<AccountRow[]> {
  const sb = adminClient();
  const [profileRes, roleRes] = await Promise.all([
    sb.from("profiles").select("id, email, full_name, active, last_login_at").order("email"),
    sb.from("user_roles").select("profile_id, roles(key)"),
  ]);

  type RoleEmbed = { key: string };
  const roleByProfile = new Map<string, string>();
  for (const row of (roleRes.data ?? []) as unknown as Array<{
    profile_id: string;
    roles: RoleEmbed | RoleEmbed[] | null;
  }>) {
    const list = Array.isArray(row.roles) ? row.roles : row.roles ? [row.roles] : [];
    if (list[0]) roleByProfile.set(row.profile_id, list[0].key);
  }

  return ((profileRes.data ?? []) as Array<{
    id: string;
    email: string;
    full_name: string | null;
    active: boolean;
    last_login_at: string | null;
  }>).map((p) => ({
    id: p.id,
    email: p.email,
    fullName: p.full_name || p.email,
    role: roleByProfile.get(p.id) ?? null,
    active: p.active,
    lastLoginAt: p.last_login_at,
  }));
}
