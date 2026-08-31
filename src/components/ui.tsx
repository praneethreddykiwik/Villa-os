import clsx from "clsx";
import type { ReactNode } from "react";

/** Shared primitives. Every page composes these so spacing/typography stay identical. */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx("card p-5", className)}>{children}</div>;
}

export function SectionTitle({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-[15px] font-semibold tracking-tight text-mist-100">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-mist-400">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

export function Stat({
  label,
  value,
  delta,
  sub,
  invertDelta = false,
}: {
  label: string;
  value: string;
  delta?: number;
  sub?: string;
  /** For metrics where down is good (CPA, CPC, CPM). */
  invertDelta?: boolean;
}) {
  const good = delta === undefined ? null : invertDelta ? delta < 0 : delta > 0;
  return (
    <div className="card p-4">
      <div className="text-[11px] font-medium uppercase tracking-wider text-mist-400">{label}</div>
      <div className="mt-2 flex items-baseline gap-2">
        <div className="tnum text-2xl font-semibold tracking-tight text-mist-100">{value}</div>
        {delta !== undefined && (
          <span
            className={clsx(
              "tnum rounded-full px-1.5 py-0.5 text-[11px] font-semibold",
              good === null ? "text-mist-400" : good ? "bg-good-500/12 text-good-400" : "bg-bad-500/12 text-bad-400",
            )}
          >
            {delta >= 0 ? "+" : ""}
            {delta.toFixed(1)}%
          </span>
        )}
      </div>
      {sub && <div className="mt-1 text-[11px] text-mist-400">{sub}</div>}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad" | "brand";
  className?: string;
}) {
  const tones = {
    neutral: "bg-ink-700 text-mist-300",
    good: "bg-good-500/12 text-good-400",
    warn: "bg-warn-500/12 text-warn-400",
    bad: "bg-bad-500/12 text-bad-400",
    brand: "bg-brand-500/15 text-brand-400",
  };
  return (
    <span className={clsx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", tones[tone], className)}>
      {children}
    </span>
  );
}

export function Dot({ color }: { color: string }) {
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />;
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="card flex flex-col items-center justify-center gap-1 p-10 text-center">
      <p className="text-sm font-medium text-mist-200">{title}</p>
      {hint && <p className="max-w-sm text-xs text-mist-400">{hint}</p>}
    </div>
  );
}

export function Bar({ value, max, color }: { value: number; max: number; color?: string }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-700">
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color ?? "var(--color-brand-500)" }} />
    </div>
  );
}

export const fmt = {
  n: (v: number) => (Math.abs(v) >= 1000 ? Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(v) : String(Math.round(v))),
  full: (v: number) => Intl.NumberFormat("en").format(Math.round(v)),
  money: (v: number) => `$${Intl.NumberFormat("en", { maximumFractionDigits: v < 100 ? 2 : 0 }).format(v)}`,
  moneyCompact: (v: number) => `$${Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(v)}`,
  pct: (v: number, d = 1) => `${v.toFixed(d)}%`,
  x: (v: number) => `${v.toFixed(2)}x`,
};
