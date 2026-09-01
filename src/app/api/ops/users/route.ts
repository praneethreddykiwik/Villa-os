import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { adminClient, hasServiceRole } from "@/lib/supabase/client";
import { requirePermission } from "@/lib/auth/session";
import { apiError, apiOk } from "@/lib/auth/http";
import { rateLimit, clientKey } from "@/lib/ops/ratelimit";

/**
 * STAFF ACCOUNT MANAGEMENT
 *
 * There is deliberately no open sign-up. This is an internal business platform;
 * anyone who can self-register can see customer records. Accounts are created by
 * someone holding `users.manage`, given exactly one role, and handed a one-time
 * password they must change on first sign-in.
 *
 * The service-role client is used here — creating an auth user is a privileged
 * operation no ordinary session can perform — so every path below checks
 * `users.manage` *before* touching it.
 */

/** Readable one-time password. Long enough that length carries the entropy. */
function temporaryPassword(): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.randomBytes(20), (b) => alphabet[b % alphabet.length]).join("");
}

export async function GET() {
  try {
    const session = await requirePermission("users.manage");
    if (!hasServiceRole()) return apiOk({ users: [], warning: "SUPABASE_SERVICE_ROLE_KEY not set" });

    const admin = adminClient();
    const { data: profiles } = await admin
      .from("profiles")
      .select("id, full_name, email, active, created_at, last_login_at, departments(key)")
      .eq("org_id", session.orgId)
      .order("full_name");

    const { data: grants } = await admin.from("user_roles").select("profile_id, roles(key, name)");
    const rolesByUser = new Map<string, string[]>();
    for (const g of (grants ?? []) as Array<{ profile_id: string; roles: { key: string } | { key: string }[] | null }>) {
      const list = Array.isArray(g.roles) ? g.roles : g.roles ? [g.roles] : [];
      rolesByUser.set(g.profile_id, [...(rolesByUser.get(g.profile_id) ?? []), ...list.map((r) => r.key)]);
    }

    const { data: roles } = await admin.from("roles").select("id, key, name, description").eq("org_id", session.orgId);

    return apiOk({
      users: (profiles ?? []).map((p) => ({
        id: p.id,
        fullName: p.full_name,
        email: p.email,
        active: p.active,
        createdAt: p.created_at,
        lastLoginAt: p.last_login_at,
        roles: rolesByUser.get(p.id) ?? [],
      })),
      roles: roles ?? [],
    });
  } catch (e) {
    return apiError(e);
  }
}

/** Create a staff account. Returns the one-time password exactly once. */
export async function POST(req: Request) {
  try {
    const session = await requirePermission("users.manage");
    // Account creation is expensive and abusable; give it its own bucket.
    const limit = rateLimit(`users:create:${session.userId}`, { max: 20, windowSeconds: 3600 });
    if (!limit.allowed) return NextResponse.json({ ok: false, error: "Too many accounts created. Try again later." }, { status: 429 });

    if (!hasServiceRole()) {
      return NextResponse.json(
        { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY is not configured, so accounts cannot be created." },
        { status: 503 },
      );
    }

    const { email, fullName, roleKey, departmentKey } = (await req.json()) as {
      email: string; fullName: string; roleKey: string; departmentKey?: string;
    };
    if (!email?.includes("@") || !fullName?.trim() || !roleKey) {
      return NextResponse.json({ ok: false, error: "Email, name and role are required." }, { status: 422 });
    }

    const admin = adminClient();
    const { data: role } = await admin.from("roles").select("id").eq("org_id", session.orgId).eq("key", roleKey).single();
    if (!role) return NextResponse.json({ ok: false, error: "Unknown role." }, { status: 422 });

    const password = temporaryPassword();
    const { data: created, error: authErr } = await admin.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      password,
      email_confirm: true, // no SMTP is configured; without this they cannot sign in
      user_metadata: { full_name: fullName.trim() },
      // The forced-rotation flag goes in app_metadata, not user_metadata. A user
      // can rewrite their own user_metadata with auth.updateUser() from the
      // browser, which meant the account handed a temporary password could clear
      // the flag that forces them to replace it and keep the one an administrator
      // has seen. app_metadata is writable only with the service role — which is
      // the client this route already holds.
      app_metadata: { must_change_password: true },
    });
    if (authErr || !created.user) {
      return NextResponse.json({ ok: false, error: authErr?.message ?? "Could not create the account." }, { status: 422 });
    }

    let departmentId: string | null = null;
    if (departmentKey) {
      const { data: dept } = await admin.from("departments").select("id").eq("org_id", session.orgId).eq("key", departmentKey).single();
      departmentId = dept?.id ?? null;
    }

    await admin.from("profiles").upsert({
      id: created.user.id,
      org_id: session.orgId,
      department_id: departmentId,
      full_name: fullName.trim(),
      email: email.trim().toLowerCase(),
      active: true,
    });
    await admin.from("user_roles").upsert({ profile_id: created.user.id, role_id: role.id });

    await admin.from("audit_logs").insert({
      org_id: session.orgId,
      actor_id: session.userId,
      actor_type: "human",
      action: "user.created",
      entity: "profiles",
      entity_id: created.user.id,
      metadata: { email, roleKey },
    });

    // Shown once, never stored. The account is forced to change it on first use.
    return apiOk({ userId: created.user.id, email, temporaryPassword: password });
  } catch (e) {
    return apiError(e);
  }
}

/** Enable/disable an account or change its role. */
export async function PATCH(req: Request) {
  try {
    const session = await requirePermission("users.manage");
    if (!hasServiceRole()) return NextResponse.json({ ok: false, error: "Service role not configured." }, { status: 503 });

    const { userId, active, roleKey } = (await req.json()) as { userId: string; active?: boolean; roleKey?: string };
    const admin = adminClient();

    const { data: target } = await admin.from("profiles").select("id, org_id").eq("id", userId).single();
    if (!target || target.org_id !== session.orgId) {
      return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
    }
    // An admin locking themselves out is a support incident, not a feature.
    if (userId === session.userId && active === false) {
      return NextResponse.json({ ok: false, error: "You cannot disable your own account." }, { status: 422 });
    }

    if (active !== undefined) {
      await admin.from("profiles").update({ active }).eq("id", userId);
      // Revoke live sessions immediately; deactivating a row is not enough on
      // its own because an issued JWT stays valid until it expires.
      if (!active) await admin.auth.admin.signOut(userId, "global").catch(() => {});
    }

    if (roleKey) {
      const { data: role } = await admin.from("roles").select("id").eq("org_id", session.orgId).eq("key", roleKey).single();
      if (!role) return NextResponse.json({ ok: false, error: "Unknown role." }, { status: 422 });
      await admin.from("user_roles").delete().eq("profile_id", userId);
      await admin.from("user_roles").insert({ profile_id: userId, role_id: role.id });
    }

    await admin.from("audit_logs").insert({
      org_id: session.orgId,
      actor_id: session.userId,
      actor_type: "human",
      action: active === false ? "user.disabled" : roleKey ? "user.role_changed" : "user.updated",
      entity: "profiles",
      entity_id: userId,
      metadata: { active, roleKey },
    });

    return apiOk({ updated: true });
  } catch (e) {
    return apiError(e);
  }
}
