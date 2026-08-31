/**
 * Deterministic id + RNG helpers.
 *
 * The seed generator must produce the *same* dataset on every machine, otherwise
 * screenshots, tests and the AI engine's example numbers drift between runs. So
 * everything random in this codebase goes through a seeded mulberry32 PRNG rather
 * than Math.random().
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seed = 20260831) {
  const r = mulberry32(seed);
  return {
    next: r,
    int: (min: number, max: number) => Math.floor(r() * (max - min + 1)) + min,
    float: (min: number, max: number) => r() * (max - min) + min,
    pick: <T,>(arr: readonly T[]): T => arr[Math.floor(r() * arr.length)],
    /** Box–Muller normal, clamped, for realistic-looking metric noise. */
    normal: (mean: number, sd: number) => {
      const u = Math.max(1e-9, r());
      const v = r();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    bool: (p = 0.5) => r() < p,
  };
}

let counter = 0;
export function id(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter.toString(36).padStart(5, "0")}`;
}

/** Non-deterministic id for runtime-created records. */
export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, n: number): Date {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}
