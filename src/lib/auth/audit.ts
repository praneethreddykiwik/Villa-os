import { adminClient, hasServiceRole } from "../supabase/client";

/**
 * AUTHENTICATION EVENTS
 *
 * Nothing in this application recorded a sign-in — not a success, not a
 * failure, not a lockout. That absence is what turns a credential leak into an
 * unanswerable question: which accounts were used, from where, and starting
 * when. It also meant a password-spraying run in progress looked exactly like
 * an idle system.
 *
 * The line carries the address, the outcome, the method and the throttling
 * source key, because those are the four fields an investigation joins on. It
 * never carries the submitted password, and it never carries the provider's
 * reason for the rejection: "user not found" versus "wrong password" sitting in
 * a log that support staff can read is the same account-enumeration oracle that
 * the deliberately generic on-screen error exists to close.
 */

export type AuthMethod = "password" | "magic_link" | "oauth";

/**
 * `requested` is the magic-link case: the link was sent (or silently not sent,
 * because the address has no account) and whether it is used is decided later
 * at the callback. Recording it as a success would claim someone signed in.
 */
export type AuthOutcome = "success" | "failure" | "throttled" | "requested";

export interface AuthEvent {
  method: AuthMethod;
  outcome: AuthOutcome;
  /** The submitted address. Empty when the flow never learned one. */
  email: string;
  /** The rate-limiter's source key for the request — see `clientKey`. */
  source: string;
}

export function logAuthEvent(e: AuthEvent): void {
  // Both values are attacker-supplied, and a log line an attacker can put a
  // newline into is a log line an attacker can forge entries in. JSON.stringify
  // escapes the separators, so a crafted address stays one field on one line.
  const line = `[auth] outcome=${e.outcome} method=${e.method} email=${JSON.stringify(e.email)} source=${JSON.stringify(e.source)} at=${new Date().toISOString()}`;
  if (e.outcome === "success") console.info(line);
  else console.warn(line);
}

/**
 * Stamp `profiles.last_login_at` for the account that just authenticated.
 *
 * The admin team screen renders this column as "last seen" and nothing had ever
 * written it, so every account read "never" — worse than showing nothing,
 * because it looks like an answer and it hides a dormant account that is
 * suddenly being used.
 *
 * It takes the service role because the RLS policy on `profiles` grants writes
 * only to a holder of `users.manage`; a member cannot stamp their own row. The
 * escalation is confined to one column, on the row of the user who has just
 * proved they hold the credential. A failure is swallowed on purpose:
 * bookkeeping must never turn a valid sign-in into a rejected one, and the log
 * line above is the durable record either way.
 */
export async function stampLastLogin(userId: string): Promise<void> {
  if (!userId || !hasServiceRole()) return;
  try {
    await adminClient()
      .from("profiles")
      .update({ last_login_at: new Date().toISOString() })
      .eq("id", userId);
  } catch {
    /* the session is already valid; do not fail the sign-in over a timestamp */
  }
}
