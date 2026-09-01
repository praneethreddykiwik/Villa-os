/**
 * Id generation.
 *
 * This module used to carry a seeded mulberry32 PRNG plus a deterministic
 * counter, so the demo generator produced a byte-identical dataset on every
 * machine. There is no generated dataset any more — every record now comes from
 * a real user action, a webhook or a live sync — so the only id the app needs is
 * a non-deterministic one that cannot collide with what is already in the store.
 */

/** Non-deterministic id for runtime-created records. */
export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
