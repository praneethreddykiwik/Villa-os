"use client";

import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  Pie, PieChart, RadialBar, RadialBarChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

/**
 * Chart wrappers.
 *
 * Charts are the one place a dashboard usually falls apart visually, so all of
 * them go through here: one tooltip, one axis treatment, one palette, one number
 * format. No page ever imports recharts directly.
 */

/* Series 1 is graphite so the dominant line matches the monochrome accent; the
   rest keep hue because separating five series without it is not possible. */
export const VIZ = ["#8b8b95", "#22d3ee", "#34d399", "#fbbf24", "#f472b6", "#a78bfa", "#fb7185"];

const compact = (v: number) =>
  Math.abs(v) >= 1000 ? Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(v) : String(v);

function ChartTooltip({ active, payload, label, prefix = "" }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-ink-600 bg-ink-850/95 px-3 py-2 shadow-xl backdrop-blur">
      <div className="mb-1 text-[11px] font-medium text-mist-300">{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2 text-[11px]">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color ?? p.fill }} />
          <span className="text-mist-400">{p.name}</span>
          <span className="tnum ml-auto font-semibold text-mist-100">
            {prefix}
            {typeof p.value === "number" ? compact(p.value) : p.value}
          </span>
        </div>
      ))}
    </div>
  );
}

const shortDate = (d: string) => {
  const dt = new Date(`${d}T00:00:00`);
  return `${dt.getDate()} ${dt.toLocaleString("en", { month: "short" })}`;
};

export function TrendArea({
  data,
  series,
  height = 240,
  prefix,
}: {
  data: Array<Record<string, string | number>>;
  series: Array<{ key: string; name: string; color?: string }>;
  height?: number;
  prefix?: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 6, right: 6, left: -18, bottom: 0 }}>
        <defs>
          {series.map((s, i) => (
            <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color ?? VIZ[i]} stopOpacity={0.35} />
              <stop offset="100%" stopColor={s.color ?? VIZ[i]} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="date" tickFormatter={shortDate} tickLine={false} axisLine={false} minTickGap={28} />
        <YAxis tickFormatter={compact} tickLine={false} axisLine={false} width={52} />
        <Tooltip content={<ChartTooltip prefix={prefix} />} />
        {series.map((s, i) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.name}
            stroke={s.color ?? VIZ[i]}
            strokeWidth={2}
            fill={`url(#g-${s.key})`}
            dot={false}
            activeDot={{ r: 3.5, strokeWidth: 0 }}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function ComboChart({
  data,
  bars,
  lines,
  height = 260,
}: {
  data: Array<Record<string, string | number>>;
  bars: Array<{ key: string; name: string; color?: string }>;
  lines: Array<{ key: string; name: string; color?: string }>;
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 6, right: 6, left: -18, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="date" tickFormatter={shortDate} tickLine={false} axisLine={false} minTickGap={28} />
        <YAxis yAxisId="l" tickFormatter={compact} tickLine={false} axisLine={false} width={52} />
        <YAxis yAxisId="r" orientation="right" tickFormatter={compact} tickLine={false} axisLine={false} width={44} />
        <Tooltip content={<ChartTooltip />} />
        <Legend wrapperStyle={{ fontSize: 11, color: "#93a0bb" }} iconType="circle" iconSize={7} />
        {bars.map((b, i) => (
          <Bar key={b.key} yAxisId="l" dataKey={b.key} name={b.name} fill={b.color ?? VIZ[i]} radius={[3, 3, 0, 0]} maxBarSize={22} />
        ))}
        {lines.map((l, i) => (
          <Line key={l.key} yAxisId="r" type="monotone" dataKey={l.key} name={l.name} stroke={l.color ?? VIZ[i + 3]} strokeWidth={2} dot={false} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function StackedBars({
  data,
  series,
  xKey = "date",
  height = 220,
}: {
  data: Array<Record<string, string | number>>;
  series: Array<{ key: string; name: string; color?: string }>;
  xKey?: string;
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 6, right: 6, left: -18, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey={xKey} tickLine={false} axisLine={false} minTickGap={20} />
        <YAxis tickFormatter={compact} tickLine={false} axisLine={false} width={48} />
        <Tooltip content={<ChartTooltip />} />
        <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" iconSize={7} />
        {series.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} name={s.name} stackId="a" fill={s.color ?? VIZ[i]} radius={i === series.length - 1 ? [3, 3, 0, 0] : undefined} maxBarSize={26} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function DonutChart({
  data,
  height = 200,
}: {
  data: Array<{ name: string; value: number; color?: string }>;
  height?: number;
}) {
  // Radii are absolute, not percentages: percentage radii inside a
  // ResponsiveContainer resolve against a box that is still zero-sized on the
  // first paint, and the sector then renders with no path at all.
  const outer = Math.round((height / 2) * 0.86);
  const inner = Math.round(outer * 0.66);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          innerRadius={inner}
          outerRadius={outer}
          paddingAngle={2}
          stroke="none"
          isAnimationActive={false}
        >
          {data.map((d, i) => (
            <Cell key={d.name} fill={d.color ?? VIZ[i % VIZ.length]} />
          ))}
        </Pie>
        <Tooltip content={<ChartTooltip />} />
      </PieChart>
    </ResponsiveContainer>
  );
}

/** The half-gauge from the reference screenshots — average rating out of 5. */
export function RatingGauge({ value, height = 170 }: { value: number; height?: number }) {
  const pct = (value / 5) * 100;
  const color = value >= 4.5 ? "#34d399" : value >= 4 ? "#a3e635" : value >= 3 ? "#fbbf24" : "#fb7185";
  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={height}>
        <RadialBarChart
          innerRadius="72%"
          outerRadius="100%"
          data={[{ name: "rating", value: pct, fill: color }]}
          startAngle={180}
          endAngle={0}
        >
          <RadialBar background={{ fill: "#1d2333" }} dataKey="value" cornerRadius={8} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-x-0 bottom-3 text-center">
        <div className="tnum text-3xl font-semibold" style={{ color }}>{value.toFixed(1)}</div>
        <div className="text-[10px] uppercase tracking-wider text-mist-400">avg rating</div>
      </div>
    </div>
  );
}

export function MiniSpark({ data, color = "#8b8b95", height = 40 }: { data: number[]; color?: string; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data.map((v, i) => ({ i, v }))} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`sp-${color.slice(1)}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.4} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.6} fill={`url(#sp-${color.slice(1)})`} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
