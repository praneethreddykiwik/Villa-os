import clsx from "clsx";
import type { ReactNode } from "react";

/** Shared primitives. Every page composes these so spacing/typography stay identical. */

export function Card({
  className,
  variant = "glass",
  interactive = false,
  children,
}: {
  className?: string;
  variant?: "glass" | "default" | "panel";
  interactive?: boolean;
  children: ReactNode;
}) {
  const baseClass = variant === "glass" ? "glass-card" : variant === "panel" ? "glass-panel rounded-2xl" : "card";
  return (
    <div
      className={clsx(
        baseClass,
        interactive && "card-interactive",
        "p-5",
        className,
      )}
    >
      {children}
    </div>
  );
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
  sparkProgress,
}: {
  label: string;
  value: string;
  delta?: number;
  sub?: string;
  invertDelta?: boolean;
  sparkProgress?: number;
}) {
  const good = delta === undefined ? null : invertDelta ? delta < 0 : delta > 0;
  return (
    <div className="glass-card card-interactive p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-mist-400">{label}</span>
        {delta !== undefined && (
          <span
            className={clsx(
              "tnum inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10.5px] font-semibold tracking-tight border",
              good === null
                ? "border-ink-700 text-mist-400"
                : good
                ? "border-good-500/25 bg-good-500/10 text-good-400"
                : "border-bad-500/25 bg-bad-500/10 text-bad-400",
            )}
          >
            {delta >= 0 ? "↑ " : "↓ "}
            {Math.abs(delta).toFixed(1)}%
          </span>
        )}
      </div>
      <div className="mt-2.5">
        <div className="tnum text-2xl font-bold tracking-tight text-mist-100">{value}</div>
      </div>
      {sub && <div className="mt-1.5 text-[11px] text-mist-400">{sub}</div>}
      {sparkProgress !== undefined && (
        <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-ink-800">
          <div
            className="h-full rounded-full bg-gradient-to-r from-brand-500 to-brand-400 transition-all duration-500"
            style={{ width: `${Math.min(100, Math.max(0, sparkProgress))}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
  pulse = false,
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad" | "brand";
  pulse?: boolean;
  className?: string;
}) {
  const tones = {
    neutral: "border-ink-700 bg-ink-800/80 text-mist-300",
    good: "border-good-500/25 bg-good-500/12 text-good-400",
    warn: "border-warn-500/25 bg-warn-500/12 text-warn-400",
    bad: "border-bad-500/25 bg-bad-500/12 text-bad-400",
    brand: "border-brand-500/30 bg-brand-500/15 text-brand-400",
  };
  const dotTones = {
    neutral: "bg-mist-400",
    good: "bg-good-400",
    warn: "bg-warn-400",
    bad: "bg-bad-400",
    brand: "bg-brand-400",
  };
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-tight shadow-sm",
        tones[tone],
        className,
      )}
    >
      {pulse && <span className={clsx("beacon-dot shrink-0", dotTones[tone])} />}
      {children}
    </span>
  );
}

export function Button({
  children,
  variant = "primary",
  size = "md",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "glass" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
}) {
  const variants = {
    primary:
      "relative overflow-hidden bg-gradient-to-b from-brand-400 to-brand-500 text-[var(--a-on)] font-medium shadow-md shadow-brand-500/15 hover:from-brand-300 hover:to-brand-400 active:translate-y-0.5 border border-white/10",
    secondary:
      "bg-ink-800 border border-ink-700 text-mist-200 hover:bg-ink-700 hover:text-mist-100 hover:border-ink-600 active:translate-y-0.5",
    glass:
      "glass-panel border-ink-700/80 text-mist-200 hover:text-mist-100 hover:border-ink-600 active:translate-y-0.5 shadow-sm",
    ghost:
      "text-mist-400 hover:text-mist-100 hover:bg-ink-800/60 active:translate-y-0.5",
    danger:
      "bg-bad-500/12 border border-bad-500/30 text-bad-400 hover:bg-bad-500/20 active:translate-y-0.5",
  };
  const sizes = {
    sm: "px-2.5 py-1 text-[11.5px] rounded-lg gap-1.5",
    md: "px-3.5 py-1.5 text-[12.5px] rounded-xl gap-2",
    lg: "px-4.5 py-2.5 text-[14px] rounded-xl gap-2.5",
  };
  return (
    <button
      className={clsx(
        "inline-flex items-center justify-center font-medium transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {children}
    </button>
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
