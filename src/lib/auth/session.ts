import { cache } from "react";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { adminClient, hasServiceRole, isSupabaseConfigured } from "../supabase/client";

/**
 * IDENTITY AND PERMISSIONS — one source of truth.
 *
 * Supabase Auth holds the credential. Supabase tables hold the roles and the
 * permissions those roles grant. Nothing else in this application decides who
 * you are or what you may do.
 *
 * The previous design kept a second local password store alongside Supabase.
 * Two credential stores for one person is a security defect regardless of how
 * carefully each is written: disabling an account in one leaves it live in the
 * other, and the weaker one sets the real security level. That store is gone.
 */

export const PERMISSIONS = [
  "customers.read", "customers.write", "inquiries.create",
  "sales.read", "sales.write",
  "loans.read", "loans.write",
  "documents.read", "documents.verify",
  "marketing.read", "marketing.publish",
  "construction.read", "construction.upload",
  "pricing.read", "pricing.negotiate",
  "analytics.view", "financials.view",
  "audit.view", "users.manage", "workflows.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export interface Session {
  userId: string;
  email: string;
  fullName: string;
  orgId: string;
  roles: string[];
  permissions: Set<Permission>;
  /**
   * Set when an administrator issued a temporary password that has not been
   * replaced yet. Carried on the session rather than checked at the sign-in
   * screen alone, because a check that only runs on one screen is skipped by
   * navigating to another one.
   */
  mustChangePassword: boolean;
}

/**
 * Why this is not just `Session | null`.
 *
 * "Not signed in" and "signed in to Supabase but not provisioned in this
 * organisation" are different situations that need different answers. Collapsing
 * them into null sent the second case back to the sign-in form it had just
 * completed, with no explanation — it looked like the password was wrong when
 * the real problem was a missing profile row only an administrator can create.
 */
export type SessionResult =
  | { status: "anonymous" }
  | { status: "unprovisioned"; email: string }
  | { status: "disabled"; email: string }
  | { status: "active"; session: Session };

export class AuthError extends Error {
  constructor(message: string, readonly status: 401 | 403 | 503) {
    super(message);
  }
}

/**
 * Read the forced-rotation flag off a Supabase user.
 *
 * The flag lives in `app_metadata` because `user_metadata` is client-writable:
 * the account holder can call `auth.updateUser({ data: { must_change_password:
 * false } })` against their own session and clear the very flag that is supposed
 * to stop them going on using an administrator-issued temporary password. That
 * made the lock advisory. `app_metadata` can only be written with the service
 * role, so it is the authoritative location.
 *
 * `user_metadata` is still read, but only when `app_metadata` says nothing at
 * all, so accounts provisioned before the move are not locked out of their own
 * rotation. Because the fallback only applies when the authoritative key is
 * absent, a `false` a user wrote for themselves can never override an
 * `app_metadata` `true`.
 */
export function readMustChangePassword(user: {
  app_metadata?: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
}): boolean {
  const authoritative = user.app_metadata?.must_change_password;
  if (authoritative !== undefined && authoritative !== null) return authoritative === true;
  return user.user_metadata?.must_change_password === true;
}

/** Reads the Supabase session from request cookies. Never trusts a header. */
async function supabaseFromCookies() {
  if (!isSupabaseConfigured()) return null;
  const store = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (list) => {
          try {
            for (const c of list) store.set(c.name, c.value, c.options);
          } catch {
            /* read-only rendering context */
          }
        },
      },
    },
  );
}

/**
 * Resolve the caller, with the reason when it is not a usable session.
 *
 * Wrapped in React's `cache`, which memoises per request — not across requests.
 * That distinction is the whole point: a session must never be shared between
 * two visitors, but a single page render used to resolve it four or five times
 * over (layout, page, and each server action), paying three sequential network
 * round trips to Supabase every time. Now the first call pays and the rest are
 * free, and revocation still takes effect on the very next request.
 */
export const resolveSession = cache(async (): Promise<SessionResult> => {
  const sb = await supabaseFromCookies();
  if (!sb) return { status: "anonymous" };

  // getUser() re-validates the JWT against Supabase. getSession() would trust
  // whatever is in the cookie, which is forgeable.
  const { data, error } = await sb.auth.getUser();
  if (error || !data.user) return { status: "anonymous" };

  const email = data.user.email ?? "";
  const mustChangePassword = readMustChangePassword(data.user);

  // Independent lookups, both keyed on the same id, so they run concurrently
  // rather than one after the other. Saves a full round trip on every render.
  const [profileRes, grantRes] = await Promise.all([
    sb.from("profiles").select("id, org_id, full_name, email, active").eq("id", data.user.id).single(),
    sb.from("user_roles").select("roles(key, role_permissions(permission_key))").eq("profile_id", data.user.id),
  ]);

  const profile = profileRes.data;
  if (!profile) return { status: "unprovisioned", email };
  if (!profile.active) return { status: "disabled", email: profile.email || email };

  type RoleEmbed = { key: string; role_permissions?: Array<{ permission_key: string }> };
  const roles: string[] = [];
  const permissions = new Set<Permission>();
  for (const row of (grantRes.data ?? []) as unknown as Array<{ roles: RoleEmbed | RoleEmbed[] | null }>) {
    const list = Array.isArray(row.roles) ? row.roles : row.roles ? [row.roles] : [];
    for (const r of list) {
      roles.push(r.key);
      for (const p of r.role_permissions ?? []) permissions.add(p.permission_key as Permission);
    }
  }

  return {
    status: "active",
    session: {
      userId: profile.id,
      email: profile.email,
      fullName: profile.full_name || profile.email,
      orgId: profile.org_id,
      roles,
      permissions,
      mustChangePassword,
    },
  };
});

/**
 * Resolve the caller. Returns null when there is no usable session — callers
 * decide whether that is an error, so a public page and a protected route can
 * share the same lookup. Use `resolveSession` when the reason matters.
 */
export async function getSession(): Promise<Session | null> {
  const result = await resolveSession();
  return result.status === "active" ? result.session : null;
}

export function hasPermission(session: Session | null, permission: Permission): boolean {
  return Boolean(session?.permissions.has(permission));
}

/**
 * Who to record against an activity entry.
 *
 * Every write route logged the literal string "user", which says that a human
 * did it and nothing else. A 500-entry ring buffer of anonymous entries is not
 * an audit trail: it cannot answer who disconnected a channel, who moved ad
 * budget, or which of seven accounts published the post — the questions the log
 * exists for. The address is the identifier the profiles table is keyed on for
 * humans, so it is what an investigation can actually join against; the display
 * name is not unique and changes when somebody marries.
 *
 * "unknown" rather than "system" for a missing session, because attributing a
 * person's action to the machine is a worse record than admitting the gap. In
 * practice these call sites sit behind `guard()`, so it does not arise.
 */
export function actorLabel(session: Session | null): string {
  return session?.email || session?.userId || "unknown";
}

/**
 * The single guard. Throws rather than returning a boolean, so a forgotten
 * `if` cannot silently grant access.
 */
export async function requirePermission(...required: Permission[]): Promise<Session> {
  if (!isSupabaseConfigured()) {
    throw new AuthError("Authentication is not configured on this deployment.", 503);
  }
  const session = await getSession();
  if (!session) throw new AuthError("Sign in to continue.", 401);
  // A session still carrying an administrator-issued temporary password may not
  // act. This used to be enforced by the app layout alone, and a layout only
  // runs for pages: every API route accepted the locked session, so the lock
  // stopped nobody who could call fetch(). It belongs here because this is the
  // one function every guarded route and page already goes through.
  //
  // The two paths out of the lock deliberately do not call it: the sign-in
  // screen resolves the session directly and `rotatePassword` talks to Supabase
  // with its own client, so gating here cannot trap someone with no way to
  // replace the password.
  if (session.mustChangePassword) {
    throw new AuthError("Set a new password before continuing.", 403);
  }
  for (const p of required) {
    if (!session.permissions.has(p)) {
      throw new AuthError(`Your role does not include ${p}.`, 403);
    }
  }
  return session;
}

/** Authenticated, no specific capability required. */
export async function requireSession(): Promise<Session> {
  return requirePermission();
}

/**
 * Server-to-server callers (cron, webhooks) present a shared secret instead of
 * a user session. Compared in constant time; refuses to run at all when the
 * secret is unset, so a missing env var fails closed rather than open.
 */
export async function requireWorkerSecret(req: Request): Promise<void> {
  const expected = process.env.WORKER_SECRET;
  if (!expected) throw new AuthError("Worker access is not configured.", 503);
  const presented = req.headers.get("x-worker-secret") ?? new URL(req.url).searchParams.get("secret") ?? "";
  const { timingSafeEqual } = await import("node:crypto");
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AuthError("Invalid worker credentials.", 401);
  }
}

/** Row-level scoping mirror of the SQL policies, for service-role reads. */
export async function assertCustomerAccess(session: Session, customerId: string): Promise<void> {
  if (session.permissions.has("analytics.view")) return; // managers and admins
  if (!hasServiceRole()) throw new AuthError("Cannot verify record ownership.", 503);
  const { data } = await adminClient()
    .from("customers")
    .select("id, org_id, owner_id, loan_officer_id, created_by")
    .eq("id", customerId)
    .single();
  if (!data || data.org_id !== session.orgId) throw new AuthError("Not found.", 403);
  const mine = [data.owner_id, data.loan_officer_id, data.created_by].includes(session.userId);
  if (!mine) throw new AuthError("This record is not assigned to you.", 403);
}
