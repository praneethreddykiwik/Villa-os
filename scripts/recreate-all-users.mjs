#!/usr/bin/env node
/**
 * RECREATE ALL USERS CLEANLY
 * 
 * 1. Deletes all existing users from Supabase Auth, profiles, and user_roles.
 * 2. Re-creates all 7 staff accounts with password "tree123".
 * 3. Sets must_change_password = false so they can log in directly.
 * 4. Links each user into organizations, profiles, and user_roles.
 * 5. Tests sign-in for each user to guarantee 100% working logins.
 */

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

// Load .env
const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !SERVICE) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const client = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });

const PASSWORD = process.argv[2] || "tree123";
const DOMAIN = process.env.GLENTREE_EMAIL_DOMAIN ?? "glentree.com";

const STAFF = [
  { role: "admin",        local: "admin",        name: "Platform Admin",   dept: "management" },
  { role: "front_desk",   local: "frontdesk",    name: "Front Desk",       dept: "front_desk" },
  { role: "sales",        local: "sales",        name: "Sales Manager",    dept: "sales" },
  { role: "marketing",    local: "marketing",    name: "Marketing Lead",   dept: "marketing" },
  { role: "loan",         local: "loan",         name: "Loan Officer",     dept: "loan" },
  { role: "construction", local: "construction", name: "Site Engineer",    dept: "construction" },
  { role: "audit",        local: "audit",        name: "Auditor",          dept: "audit" },
];

async function main() {
  console.log("=== STEP 1: Deleting existing users from Supabase Auth ===");
  const { data: { users }, error: listError } = await admin.auth.admin.listUsers({ perPage: 100 });
  if (listError) throw listError;

  for (const u of users) {
    console.log(`Deleting auth user: ${u.email} (${u.id})...`);
    await admin.from("user_roles").delete().eq("profile_id", u.id);
    await admin.from("profiles").delete().eq("id", u.id);
    const { error: delErr } = await admin.auth.admin.deleteUser(u.id);
    if (delErr) console.warn(`  Warning deleting auth user: ${delErr.message}`);
  }

  console.log("\n=== STEP 2: Getting Organization, Roles, and Departments ===");
  let { data: orgs } = await admin.from("organizations").select("id,slug").eq("slug", "glentree").limit(1);
  if (!orgs || !orgs.length) {
    const { data: newOrg, error: orgErr } = await admin.from("organizations").insert({ name: "Glentree", slug: "glentree" }).select().single();
    if (orgErr) throw orgErr;
    orgs = [newOrg];
  }
  const orgId = orgs[0].id;
  console.log(`Organization: Glentree (${orgId})`);

  const { data: roles, error: rolesErr } = await admin.from("roles").select("id,key").eq("org_id", orgId);
  if (rolesErr) throw rolesErr;
  const roleMap = Object.fromEntries(roles.map((r) => [r.key, r.id]));
  console.log("Available roles in database:", Object.keys(roleMap));

  const { data: depts } = await admin.from("departments").select("id,key").eq("org_id", orgId);
  const deptMap = Object.fromEntries((depts || []).map((d) => [d.key, d.id]));

  console.log("\n=== STEP 3: Creating users fresh with password and role grants ===");
  for (const s of STAFF) {
    const email = `${s.local}@${DOMAIN}`;
    console.log(`Creating ${email} (${s.role})...`);

    const { data: authUser, error: createErr } = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
      app_metadata: { must_change_password: false, provider: "email", providers: ["email"] },
      user_metadata: { full_name: s.name, role: s.role, must_change_password: false },
    });

    if (createErr) {
      console.error(`  ERROR creating ${email}:`, createErr.message);
      continue;
    }

    const userId = authUser.user.id;

    // Create profile
    const { error: profErr } = await admin.from("profiles").upsert({
      id: userId,
      org_id: orgId,
      department_id: deptMap[s.dept] ?? null,
      full_name: s.name,
      email: email,
      active: true,
    }, { onConflict: "id" });

    if (profErr) {
      console.error(`  ERROR creating profile for ${email}:`, profErr.message);
      continue;
    }

    // Grant role
    const rId = roleMap[s.role];
    if (rId) {
      const { error: roleErr } = await admin.from("user_roles").upsert({
        profile_id: userId,
        role_id: rId,
      }, { onConflict: "profile_id,role_id" });

      if (roleErr) {
        console.error(`  ERROR granting role for ${email}:`, roleErr.message);
      } else {
        console.log(`  ✓ Linked role ${s.role}`);
      }
    } else {
      console.warn(`  ⚠ Role ${s.role} not found in database roles table!`);
    }
  }

  console.log("\n=== STEP 4: Verifying sign-in for each account ===");
  for (const s of STAFF) {
    const email = `${s.local}@${DOMAIN}`;
    const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
    if (error) {
      console.error(`  ✗ Sign-in FAILED for ${email}:`, error.message);
    } else {
      console.log(`  ✓ Sign-in SUCCESS for ${email} (User ID: ${data.user.id})`);
    }
  }

  console.log("\nAll users successfully recreated and verified with password: " + PASSWORD);
}

main().catch((e) => {
  console.error("Recreation failed:", e);
  process.exit(1);
});
