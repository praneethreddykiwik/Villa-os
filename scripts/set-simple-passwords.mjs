#!/usr/bin/env node
/**
 * Reset staff passwords in Supabase Auth.
 *
 * Usage: STAFF_PASSWORD=<value> node scripts/set-simple-passwords.mjs
 *    or: node scripts/set-simple-passwords.mjs            (generates one)
 *
 * THERE IS NO DEFAULT PASSWORD, AND THERE MUST NEVER BE ONE AGAIN.
 * This file previously hardcoded a 7-character literal and applied it to all
 * seven staff accounts. The repository is public, so that password was
 * readable by anyone who found the repo, on every account, with rotation
 * disabled. A committed default credential is a published credential.
 *
 * The generated password is written to .provisioned-credentials.txt
 * (gitignored, mode 600) rather than printed, because terminal scrollback ends
 * up in screenshots and support tickets.
 */

import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** 20 chars, no ambiguous glyphs — these get read off a screen and retyped. */
function generatePassword() {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.randomBytes(20), (b) => alphabet[b % alphabet.length]).join("");
}

const newPassword = process.env.STAFF_PASSWORD || generatePassword();
if (newPassword.length < 12) {
  console.error("STAFF_PASSWORD must be at least 12 characters. Refusing to set a weak password.");
  process.exit(1);
}

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
  console.log(`Setting a new password for ${EMAILS.length} staff accounts...`);
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
      // Forced rotation. An administrator-issued password is a delivery
      // mechanism, not a credential — the person must replace it before the
      // session is good for anything. requirePermission() refuses every
      // permission while this flag is set, so it cannot be navigated around.
      app_metadata: { ...(u.app_metadata ?? {}), must_change_password: true },
    });
    if (updateError) {
      console.log(`- ${email}: FAILED (${updateError.message})`);
    } else {
      console.log(`- ${email}: SUCCESS`);
    }
  }

  if (!process.env.STAFF_PASSWORD) {
    // Written, not printed: scrollback ends up in screenshots and tickets.
    fs.writeFileSync(
      ".provisioned-credentials.txt",
      `GLENTREE - staff password reset ${new Date().toISOString()}\n\n` +
        `Password (all accounts): ${newPassword}\n\n` +
        `Every account must change this on first sign-in.\n`,
      { mode: 0o600 },
    );
    console.log("\nPassword saved to .provisioned-credentials.txt (gitignored, chmod 600).");
  }
  console.log("All accounts must change their password on next sign-in.");
}

run().catch((e) => console.error(e));
