/**
 * Indian currency and number formatting.
 *
 * Rupee amounts in real estate are read in lakh and crore, not millions — a
 * price shown as "$1.5M" is unreadable to the person actually selling the unit.
 * Grouping is 2-2-3 (₹1,25,00,000), which Intl handles via the en-IN locale.
 */

const CRORE = 1e7;
const LAKH = 1e5;

/** ₹4.5 Cr · ₹85 L · ₹42,000 */
export function inr(amount: number, opts: { precise?: boolean } = {}): string {
  if (!Number.isFinite(amount)) return "—";
  const abs = Math.abs(amount);
  if (opts.precise || abs < LAKH) return `₹${Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(amount)}`;
  if (abs >= CRORE) {
    const cr = amount / CRORE;
    return `₹${cr.toFixed(cr >= 100 ? 0 : cr >= 10 ? 1 : 2).replace(/\.?0+$/, "")} Cr`;
  }
  const l = amount / LAKH;
  return `₹${l.toFixed(l >= 10 ? 0 : 1).replace(/\.?0+$/, "")} L`;
}

/** "₹3 – 5 Cr", collapsing to one figure when the band is a point estimate. */
export function inrRange(min: number, max: number): string {
  if (min === max) return inr(min);
  const a = inr(min);
  const b = inr(max);
  // Drop the repeated unit: "₹3 – 5 Cr" reads better than "₹3 Cr – ₹5 Cr".
  const unit = a.match(/(Cr|L)$/)?.[1];
  if (unit && b.endsWith(unit)) return `${a.replace(` ${unit}`, "")} – ${b}`;
  return `${a} – ${b}`;
}

export function relativeDay(iso?: string): string {
  if (!iso) return "—";
  const diff = Math.round((new Date(iso).getTime() - Date.now()) / 86400000);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  return diff > 0 ? `in ${diff}d` : `${Math.abs(diff)}d ago`;
}

export function shortDate(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export function dateTime(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}
