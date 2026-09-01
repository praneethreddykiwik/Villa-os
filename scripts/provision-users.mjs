#!/usr/bin/env node
/**
 * STAFF PROVISIONING
 *
 * Creates one Supabase Auth user per role, then links each to a `profiles` row
 * and its `user_roles` grant.
 *
 * Design notes:
 *  - Passwords are generated here and never stored in the repo. They are written
 *    to .provisioned-credentials.txt (gitignored) and printed once.
 *  - `email_confirm: true` is required because this project has email
 *    confirmation on with no SMTP configured; without it every account would be
 *    created but unable to sign in.
 *  - Idempotent. Re-running finds existing users by email and only fills in
 *    whatever is missing, so it is safe to run before *and* after the schema
 *    migration.
 */

import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Minimal .env.local loader — avoids a dependency for a one-shot script.
const envPath = path.join(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !SERVICE) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

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

/** 20 chars, no ambiguous glyphs — these get read off a screen and retyped. */
function password() {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.randomBytes(20), (b) => alphabet[b % alphabet.length]).join("");
}

async function findUserByEmail(email) {
  // listUsers is paginated; the staff list is small so one page suffices.
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (error) throw error;
  return data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
}

async function main() {
  const created = [];

  // ---- 1. Auth users. Works whether or not the schema has been applied. ----
  for (const s of STAFF) {
    const email = `${s.local}@${DOMAIN}`;
    const existing = await findUserByEmail(email);
    if (existing) {
      created.push({ ...s, email, id: existing.id, password: null, status: "already existed" });
      continue;
    }
    const pw = password();
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: pw,
      email_confirm: true, // no SMTP configured; without this they cannot sign in
      user_metadata: { full_name: s.name, role: s.role },
    });
    if (error) {
      created.push({ ...s, email, id: null, password: null, status: `FAILED: ${error.message}` });
      continue;
    }
    created.push({ ...s, email, id: data.user.id, password: pw, status: "created" });
  }

  // ---- 2. Link to profiles + user_roles, if the schema exists. ------------
  const { data: orgs, error: orgErr } = await admin.from("organizations").select("id,slug").eq("slug", "glentree").limit(1);
  const schemaReady = !orgErr && orgs?.length;

  if (!schemaReady) {
    console.log("\n⚠  Schema not applied yet — auth users exist but are not linked to profiles/roles.");
    console.log("   Run supabase/glentree_complete.sql in the SQL Editor, then re-run this script.\n");
  } else {
    const orgId = orgs[0].id;
    const { data: roles } = await admin.from("roles").select("id,key").eq("org_id", orgId);
    const { data: depts } = await admin.from("departments").select("id,key").eq("org_id", orgId);
    const roleId = Object.fromEntries((roles ?? []).map((r) => [r.key, r.id]));
    const deptId = Object.fromEntries((depts ?? []).map((d) => [d.key, d.id]));

    for (const u of created) {
      if (!u.id) continue;
      const { error: pErr } = await admin.from("profiles").upsert(
        {
          id: u.id,
          org_id: orgId,
          department_id: deptId[u.dept] ?? null,
          full_name: u.name,
          email: u.email,
          active: true,
        },
        { onConflict: "id" },
      );
      if (pErr) { u.status += ` | profile error: ${pErr.message}`; continue; }

      if (roleId[u.role]) {
        const { error: rErr } = await admin
          .from("user_roles")
          .upsert({ profile_id: u.id, role_id: roleId[u.role] }, { onConflict: "profile_id,role_id" });
        if (rErr) u.status += ` | role error: ${rErr.message}`;
        else u.status += " | linked";
      }
    }
  }

  // ---- 3. Report --------------------------------------------------------
  const withPw = created.filter((c) => c.password);
  const lines = [
    "GLENTREE — staff credentials",
    `Generated ${new Date().toISOString()}`,
    `Supabase: ${URL}`,
    "",
    "These are shown once. Change them after first sign-in.",
    "",
    ...created.map((c) => `${c.role.padEnd(13)} ${c.email.padEnd(28)} ${c.password ?? "(unchanged)"}   [${c.status}]`),
  ];
  fs.writeFileSync(".provisioned-credentials.txt", lines.join("\n") + "\n", { mode: 0o600 });

  console.log("\n" + lines.join("\n"));
  console.log(`\n${withPw.length} new account(s). Saved to .provisioned-credentials.txt (gitignored, chmod 600).`);
}

main().catch((e) => {
  console.error("Provisioning failed:", e.message);
  process.exit(1);
});
