import { adminClient, hasServiceRole, isSupabaseConfigured, supabaseUrl } from "./client";

/**
 * Server-side verification of a Supabase access token.
 *
 * The browser signs in with Supabase and hands us the resulting token. We do
 * NOT trust it — the token is presented back to Supabase's own /auth/v1/user
 * endpoint, which is the only thing that can vouch for it. Only then do we
 * issue an application session.
 *
 * This is what lets Supabase Auth be the single credential store while the
 * existing ops pages keep their own session cookie: one sign-in, one password,
 * independently verified.
 */

export interface VerifiedUser {
  id: string;
  email: string;
  fullName: string;
  orgId: string;
  roleKeys: string[];
  permissions: string[];
}

export async function verifySupabaseToken(accessToken: string): Promise<VerifiedUser | null> {
  if (!isSupabaseConfigured() || !accessToken) return null;

  const res = await fetch(`${supabaseUrl()}/auth/v1/user`, {
    headers: {
      apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const user = (await res.json()) as { id: string; email?: string };
  if (!user?.id) return null;

  // The token proves identity; the database decides what that identity may do.
  if (!hasServiceRole()) {
    return { id: user.id, email: user.email ?? "", fullName: user.email ?? "", orgId: "", roleKeys: [], permissions: [] };
  }

  const admin = adminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("id, org_id, full_name, email, active")
    .eq("id", user.id)
    .single();

  if (!profile || !profile.active) return null;

  const { data: grants } = await admin
    .from("user_roles")
    .select("roles(key, role_permissions(permission_key))")
    .eq("profile_id", user.id);

  // PostgREST types embedded relations as arrays; normalise either shape.
  type RoleEmbed = { key: string; role_permissions?: Array<{ permission_key: string }> };
  const roleKeys: string[] = [];
  const permissions = new Set<string>();
  for (const row of (grants ?? []) as unknown as Array<{ roles: RoleEmbed | RoleEmbed[] | null }>) {
    const roles = Array.isArray(row.roles) ? row.roles : row.roles ? [row.roles] : [];
    for (const r of roles) {
      roleKeys.push(r.key);
      for (const p of r.role_permissions ?? []) permissions.add(p.permission_key);
    }
  }

  return {
    id: profile.id,
    email: profile.email,
    fullName: profile.full_name || profile.email,
    orgId: profile.org_id,
    roleKeys,
    permissions: [...permissions],
  };
}
