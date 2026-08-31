/** Small statistics toolkit used by the anomaly + fatigue detectors. */

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Robust z-score using median + MAD instead of mean + stdev.
 *
 * Why: one viral day would inflate the mean and stdev enough to hide every other
 * anomaly for the rest of the window. MAD barely moves, so the detector keeps
 * working after a spike.
 */
export function robustZ(value: number, history: number[]): number {
  if (history.length < 5) return 0;
  const med = median(history);
  const mad = median(history.map((h) => Math.abs(h - med)));
  const scale = mad === 0 ? stdev(history) || 1 : mad * 1.4826;
  return (value - med) / scale;
}

/** Least-squares slope, normalised to "percent change per step" of the mean. */
export function trendSlopePct(series: number[]): number {
  const n = series.length;
  if (n < 3) return 0;
  const xm = (n - 1) / 2;
  const ym = mean(series);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xm) * (series[i] - ym);
    den += (i - xm) ** 2;
  }
  const slope = den ? num / den : 0;
  return ym ? (slope / ym) * 100 : 0;
}

/**
 * Wilson lower bound on a rate. Used to rank posts/ads fairly when one has
 * 40 impressions and another has 40,000 — a 10% CTR on 40 impressions should not
 * outrank 4% on 40,000.
 */
export function wilsonLower(successes: number, trials: number, z = 1.96): number {
  if (trials === 0) return 0;
  const p = successes / trials;
  const denom = 1 + (z * z) / trials;
  const centre = p + (z * z) / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * trials)) / trials);
  return Math.max(0, (centre - margin) / denom);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
