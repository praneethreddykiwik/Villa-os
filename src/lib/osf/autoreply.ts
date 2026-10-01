/**
 * Which channels this deployment is allowed to answer on its own.
 *
 * There is more than one program holding this company's messaging credentials.
 * The VPS app owns the Evolution WhatsApp number and replies to it; this
 * dashboard reads the same Supabase tables and lets a human reply. Two
 * programs answering one inbox means every customer gets two replies, and the
 * failure is invisible from inside either one — each looks like it is working.
 *
 * So auto-reply is opt-in per channel, and off when unset. A webhook that
 * arrives on a channel not listed here is still recorded in full — the lead,
 * the conversation, the message, the attribution. It simply does not generate
 * an answer. Reading is always safe; speaking is what collides.
 *
 * Set MESSAGING_AUTOREPLY_CHANNELS to a comma-separated list to opt in, e.g.
 *   MESSAGING_AUTOREPLY_CHANNELS=instagram,messenger
 * Anything absent, empty, or unrecognised stays silent.
 */

/**
 * The Meta DM channels this module governs.
 *
 * WhatsApp is deliberately absent. Evolution's webhook is owned by the VPS, so
 * this app refuses that inbound entirely (EVOLUTION_INBOUND, a 410 in
 * src/app/api/osf/evolution/route.ts) rather than accepting the message and
 * staying quiet. The two policies differ because the situations differ: on
 * WhatsApp another program is already recording the message, so accepting it
 * here would duplicate the row as well as the reply. On Instagram and
 * Messenger nothing else is listening, so ingesting is the whole point — only
 * answering is in question.
 */
export const AUTOREPLY_CHANNELS = ["instagram", "messenger"] as const;

export type AutoReplyChannel = (typeof AUTOREPLY_CHANNELS)[number];

function configured(): Set<string> {
  const raw = process.env.MESSAGING_AUTOREPLY_CHANNELS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Messenger answers to two names by design: the Postgres enum spells it
 * `facebook`, the transport module and Meta's own docs call it Messenger. An
 * operator should not have to know which of those this file wanted.
 */
const ALIASES: Record<string, string> = { facebook: "messenger", fb: "messenger", ig: "instagram" };

function normalise(channel: string): string {
  const key = channel.trim().toLowerCase();
  return ALIASES[key] ?? key;
}

/**
 * True only when this deployment has been explicitly told to answer on this
 * channel. Fails closed: unset, empty, misspelled and unknown all mean no.
 */
export function autoReplyEnabled(channel: string): boolean {
  const set = new Set([...configured()].map(normalise));
  if (set.size === 0) return false;
  const key = normalise(channel);
  // "all" is deliberately not supported. Turning on every channel at once is
  // exactly the mistake this module exists to prevent, and spelling out the
  // list is a one-time cost paid by whoever accepts the consequence.
  return set.has(key);
}

/**
 * Why a channel is silent, for the log line at the webhook. Phrased for
 * whoever is wondering why the agent "isn't working" — the usual reason is
 * that it is working exactly as configured.
 */
export function autoReplyStatus(channel: string): string {
  return autoReplyEnabled(channel)
    ? `auto-reply on (${channel})`
    : `auto-reply off for ${channel} — message recorded, no answer sent. ` +
        `Set MESSAGING_AUTOREPLY_CHANNELS to change this.`;
}
