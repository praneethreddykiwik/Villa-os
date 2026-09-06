#!/usr/bin/env node
/**
 * Quick script to update staff passwords in Supabase Auth.
 * Usage: node scripts/set-simple-passwords.mjs [new_password]
 * Default password: tree123 (6 chars for Supabase GoTrue compliance)
 */

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const newPassword = process.argv[2] || "tree123";

// Load .env
const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !SERVICE) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const EMAILS = [
  "admin@glentree.com",
  "frontdesk@glentree.com",
  "sales@glentree.com",
  "marketing@glentree.com",
  "loan@glentree.com",
  "construction@glentree.com",
  "audit@glentree.com",
];

async function run() {
  console.log(`Setting password to "${newPassword}" for ${EMAILS.length} staff accounts...`);
  const { data: { users }, error: listError } = await admin.auth.admin.listUsers({ perPage: 100 });
  if (listError) throw listError;

  for (const email of EMAILS) {
    const u = users.find((x) => x.email?.toLowerCase() === email.toLowerCase());
    if (!u) {
      console.log(`- ${email}: NOT FOUND in Supabase`);
      continue;
    }
    const { error: updateError } = await admin.auth.admin.updateUserById(u.id, {
      password: newPassword,
    });
    if (updateError) {
      console.log(`- ${email}: FAILED (${updateError.message})`);
    } else {
      console.log(`- ${email}: SUCCESS -> ${newPassword}`);
    }
  }
}

run().catch((e) => console.error(e));
