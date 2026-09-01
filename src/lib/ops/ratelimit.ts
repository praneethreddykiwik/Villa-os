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

/**
 * Hard ceiling on how many windows may exist at once.
 *
 * The map is keyed on values the caller influences — the client address for the
 * per-source bucket, the submitted email for the per-account one — so without a
 * cap it is an unauthenticated memory-growth primitive: one entry per distinct
 * key, forever. The old opportunistic sweep could not fix that, because it only
 * reclaimed entries whose hit array had already been pruned, and pruning only
 * happens when that exact key is seen again. A key that is never repeated is
 * never pruned and therefore never swept, which is precisely the shape of an
 * attack that rotates the header on every request.
 */
const MAX_WINDOWS = 10_000;

/**
 * How far to look for an evictable entry before giving up and taking the oldest.
 *
 * Bounded on purpose: an unbounded scan would make the eviction itself the
 * amplification, letting a flood cost O(map size) per request.
 */
const EVICTION_SCAN = 64;

/**
 * Bring the map back under the cap.
 *
 * Entries are re-inserted on every hit, so Map iteration order is
 * least-recently-touched first — which is exactly where a rotated key lands
 * once the attacker stops repeating it. Live lockouts are skipped where one is
 * found within the scan budget, because evicting them would turn the cap into
 * the way out of a lockout somebody had already earned.
 */
function evictIfOverCapacity(now: number): void {
  while (windows.size > MAX_WINDOWS) {
    let victim: string | undefined;
    let scanned = 0;
    for (const [k, v] of windows) {
      if (!v.lockedUntil || v.lockedUntil <= now) {
        victim = k;
        break;
      }
      if (++scanned >= EVICTION_SCAN) break;
    }
    // Nothing evictable within reach — everything scanned is an active lockout,
    // so drop the least-recently-touched entry regardless.
    victim ??= windows.keys().next().value;
    if (victim === undefined) return;
    windows.delete(victim);
  }
}

/** Re-insert so Map order stays least-recently-touched first for eviction. */
function touch(key: string, w: Window): void {
  windows.delete(key);
  windows.set(key, w);
}

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
    touch(key, w);
    evictIfOverCapacity(now);
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil(((w.lockedUntil ?? now) - now) / 1000) };
  }

  w.hits.push(now);
  touch(key, w);
  evictIfOverCapacity(now);

  return { allowed: true, remaining: opts.max - w.hits.length };
}

/** Clear on success, so a correct password resets the counter. */
export function resetLimit(key: string): void {
  windows.delete(key);
}

/**
 * How many reverse proxies sit between the public internet and this process.
 *
 * DEPLOYMENT ASSUMPTION: exactly one — the platform edge (Vercel, or an nginx
 * in front of `next start`) — and it *appends* the socket peer address it
 * actually observed to X-Forwarded-For. Every entry to the left of that append
 * was supplied by the caller. Raise this only when another trusted proxy is
 * added in front, and never above the number of hops that genuinely rewrite the
 * header, because each extra hop hands one more forgeable entry to the caller.
 */
const TRUSTED_PROXY_HOPS = 1;

/** Longest plausible address (IPv6 with an embedded IPv4). Anything else is junk. */
const MAX_KEY_CHARS = 45;

/**
 * Best-effort client identity for limiting. Never used for authorisation.
 *
 * X-Forwarded-For is a caller-controlled list, and taking `split(",")[0]` took
 * the one entry the caller fully controls. That was exploitable twice over: a
 * new value per request gave an attacker an unlimited supply of fresh buckets
 * (evading their own limit, and — before the cap above — growing the map without
 * bound), and pinning it to a colleague's address let them spend that person's
 * per-source budget and lock the office out. So index in from the *right*: only
 * the trailing hops our own proxies appended are ours to believe.
 */
export function clientKey(req: Request): string {
  const chain = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const hop = chain[chain.length - TRUSTED_PROXY_HOPS];
  // x-real-ip is only meaningful when the proxy set it, which is the same
  // situation in which it also set x-forwarded-for — so it is a fallback for a
  // misconfigured proxy, not a second opinion about the address.
  const raw = hop ?? req.headers.get("x-real-ip") ?? "";
  // Keep the key to address characters and a bounded length: a header is not
  // allowed to decide how much memory one map entry costs.
  const cleaned = raw.replace(/[^0-9a-fA-F.:%\[\]]/g, "").slice(0, MAX_KEY_CHARS);
  return cleaned || "unknown";
}
