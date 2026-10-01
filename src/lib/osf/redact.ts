/**
 * Redaction for log lines.
 *
 * Logs leave the building. Vercel ships them to its own retention, and anyone
 * with project access can read them months later — so a phone number written
 * here is a customer contact detail sitting in a third-party system nobody is
 * treating as a customer database.
 *
 * The operational need is real though: when a reply is skipped you have to be
 * able to tell *which* conversation it was, or the line is useless for
 * debugging. So these keep the last four digits — enough to match against a
 * thread you already have open in the console, not enough to be a contact list
 * if the logs are exposed.
 */

/**
 * `919876543210` → `+91•••••3210`, `9876543210` → `•••••••3210`.
 *
 * Country code is kept because it is not identifying on its own and it is what
 * tells you which transport the message arrived on.
 */
export function maskPhone(raw: string | null | undefined): string {
  if (!raw) return "(none)";
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length < 4) return "•••";
  const tail = digits.slice(-4);
  // 12 digits = country code + 10-digit national number (the Indian case).
  const cc = digits.length > 10 ? digits.slice(0, digits.length - 10) : "";
  return `${cc ? `+${cc}` : ""}${"•".repeat(Math.max(3, digits.length - tail.length - cc.length))}${tail}`;
}

/**
 * Instagram sender ids are opaque account identifiers, not phone numbers, but
 * they are still a stable handle to one person — so the same rule applies.
 */
export function maskId(raw: string | null | undefined): string {
  if (!raw) return "(none)";
  const s = String(raw);
  if (s.length <= 4) return "•••";
  return `${"•".repeat(Math.max(3, s.length - 4))}${s.slice(-4)}`;
}
