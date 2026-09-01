/**
 * RATE LIMITING
 *
 * ── Known limitation ─────────────────────────────────────────────────────────
 * This is an in-process sliding window. It is correct for a single instance and
 * does nothing across a horizontally-scaled deployment — behind more than one
 * process, an attacker gets N× the attempts. Move the two functions below to
 * Redis (INCR + EXPIRE) before running multiple instances.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Applied to authentication, where unlimited attempts turn any weak password
 * into a compromised account.
 */

interface Window {
  hits: number[];
  lockedUntil?: number;
}

const windows = new Map<string, Window>();

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds?: number;
}

export function rateLimit(
  key: string,
  opts: { max: number; windowSeconds: number; lockoutSeconds?: number } = { max: 5, windowSeconds: 300 },
): LimitResult {
  const now = Date.now();
  const w = windows.get(key) ?? { hits: [] };

  if (w.lockedUntil && w.lockedUntil > now) {
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil((w.lockedUntil - now) / 1000) };
  }

  w.hits = w.hits.filter((t) => now - t < opts.windowSeconds * 1000);
  if (w.hits.length >= opts.max) {
    // Escalating lockout, so repeated bursts cost progressively more.
    w.lockedUntil = now + (opts.lockoutSeconds ?? opts.windowSeconds) * 1000;
    windows.set(key, w);
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil(((w.lockedUntil ?? now) - now) / 1000) };
  }

  w.hits.push(now);
  windows.set(key, w);

  // Opportunistic sweep so a long-lived process does not grow unbounded.
  if (windows.size > 5000) {
    for (const [k, v] of windows) {
      if (!v.hits.length && (!v.lockedUntil || v.lockedUntil < now)) windows.delete(k);
    }
  }

  return { allowed: true, remaining: opts.max - w.hits.length };
}

/** Clear on success, so a correct password resets the counter. */
export function resetLimit(key: string): void {
  windows.delete(key);
}

/** Best-effort client identity for limiting. Never used for authorisation. */
export function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || req.headers.get("x-real-ip") || "unknown";
}
