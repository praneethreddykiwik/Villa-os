import Link from "next/link";
import { ArrowUpRight, Sparkles } from "lucide-react";
import { pageContext, qs } from "@/lib/page-context";
import {
  adStatsFor, adTotals, rollupByChannel, statsFor, timeseries, totals, pctChange,
} from "@/lib/metrics/aggregate";
import { ensureFreshStats } from "@/lib/engine/freshness";
import { generateSuggestions } from "@/lib/ai/signals";
import { deterministicSummary } from "@/lib/ai/narrative";
import { channelMeta } from "@/lib/platforms/registry";
import { TopBar } from "@/components/shell";
import { Card, SectionTitle, Stat, Badge, Dot, Bar, fmt } from "@/components/ui";
import { ComboChart, DonutChart, TrendArea, VIZ } from "@/components/charts";
import { SuggestionCard } from "@/components/suggestion-card";
import { YouTubeSnapshotBlock } from "@/components/analytics/youtube-snapshot-block";
import { SocialOverview } from "@/components/analytics/social-overview";
import { AdsCard } from "@/components/analytics/ads-card";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  // Refresh YouTube rows older than ten minutes before reading; a failed
  // refresh renders the stale store rather than an error.
  const pre = pageContext(sp);
  const fresh = await ensureFreshStats(pre.brandId);
  const { db, brand, brandId, range, prev, days } = fresh.refreshed ? pageContext(sp) : pre;
  const link = qs(sp);

  const stats = statsFor(db, brandId);
  const t = totals(stats, range);
  const tPrev = totals(stats, prev);
  const ads = adTotals(adStatsFor(db, brandId, range));
  const adsPrev = adTotals(adStatsFor(db, brandId, prev));
  const series = timeseries(stats, range);
  const channels = rollupByChannel(stats, range);
  const suggestions = generateSuggestions(db, brandId, range);

  // The summary only rewrites the totals — it never adds facts. With nothing
  // measured yet every number in it is a zero, and "reached 0 people, up 0.0% on
  // the previous period" is a fluent sentence about nothing. Gate on whether any
  // organic or paid activity was actually recorded, and say so plainly when not.
  const hasReportableData =
    t.impressions > 0 || t.engagements > 0 || t.posts > 0 || ads.spend > 0 || ads.impressions > 0;
  const summary = hasReportableData
    ? deterministicSummary({
        brand, period: `the last ${days} days`, totals: t, previousTotals: tPrev,
        ads, previousAds: adsPrev, suggestions,
      })
    : null;

  // Daily paid spend vs. ROAS — the single chart most clients ask for first.
  const adDaily = new Map<string, { date: string; spend: number; revenue: number; roas: number }>();
  for (const r of adStatsFor(db, brandId, range)) {
    const row = adDaily.get(r.date) ?? { date: r.date, spend: 0, revenue: 0, roas: 0 };
    row.spend += r.spend;
    row.revenue += r.conversionValue;
    adDaily.set(r.date, row);
  }
  const adSeries = [...adDaily.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => ({ ...r, spend: Number(r.spend.toFixed(0)), revenue: Number(r.revenue.toFixed(0)), roas: Number((r.spend ? r.revenue / r.spend : 0).toFixed(2)) }));

  const maxImpr = Math.max(...channels.map((c) => c.impressions), 1);
  const upcoming = db.posts
    .filter((p) => p.brandId === brandId && p.scheduledAt && new Date(p.scheduledAt) > new Date(`${range.to}T00:00:00Z`))
    .sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!))
    .slice(0, 5);

  return (
    <>
      <TopBar
        brands={db.brands}
        brandId={brandId}
        title="Dashboard"
        subtitle={`${brand.name} · ${range.from} → ${range.to}`}
        right={
          <Link
            href={`/composer${link}`}
            className="holographic-sheen inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[12px] font-semibold text-white shadow-md shadow-purple-500/25 transition-transform active:scale-[0.97]"
          >
            <Sparkles size={13} />
            Compose
          </Link>
        }
      />

      <div className="space-y-6 p-7">
        {/* AI executive summary — the thing a business owner actually reads. */}
        <Card className="rise border-brand-500/25 bg-gradient-to-br from-brand-500/[0.07] to-transparent">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand-500/15 text-brand-400">
              <Sparkles size={14} />
            </span>
            <div className="min-w-0">
              <div className="mb-1 flex items-center gap-2">
                <h2 className="text-[13px] font-semibold">What happened, and what to do next</h2>
                {/* Badge the state honestly: nothing was summarised, so nothing claims to be a summary. */}
                <Badge tone={summary ? "brand" : "neutral"}>{summary ? "AI summary" : "No data yet"}</Badge>
              </div>
              {summary ? (
                <p className="text-[13px] leading-relaxed text-mist-300">{summary}</p>
              ) : (
                <p className="text-[13px] leading-relaxed text-mist-400">
                  Nothing has been measured for {brand.name} yet — no posts published, no ad spend, no
                  channel reporting in the last {days} days. Connect a channel and publish, and the
                  read-out of what happened and what to do next appears here.
                </p>
              )}
            </div>
          </div>
        </Card>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
          <Stat label="Impressions" value={fmt.n(t.impressions)} delta={pctChange(t.impressions, tPrev.impressions)} sub={`${fmt.n(t.reach)} reach`} />
          <Stat label="Engagements" value={fmt.n(t.engagements)} delta={pctChange(t.engagements, tPrev.engagements)} sub={fmt.pct(t.engagementRate, 2) + " rate"} />
          <Stat label="Followers" value={fmt.n(t.followers)} delta={pctChange(t.followers, tPrev.followers)} sub={`${t.followerDelta >= 0 ? "+" : ""}${fmt.full(t.followerDelta)} net`} />
          <Stat label="Ad spend" value={fmt.moneyCompact(ads.spend)} delta={pctChange(ads.spend, adsPrev.spend)} sub={`${fmt.money(ads.cpm)} CPM`} />
          <Stat label="ROAS" value={fmt.x(ads.roas)} delta={pctChange(ads.roas, adsPrev.roas)} sub={`${fmt.money(ads.conversionValue)} revenue`} />
          <Stat label="Cost / conversion" value={fmt.money(ads.cpa)} delta={pctChange(ads.cpa, adsPrev.cpa)} invertDelta sub={`${Math.round(ads.conversions)} conversions`} />
        </div>

        <SocialOverview db={db} brandId={brandId} range={range} lastSyncedAt={fresh.lastSyncedAt} link={link} />

        <div className="grid gap-5 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <SectionTitle
              title="Organic reach & engagement"
              hint="All connected channels combined, one point per day"
              action={<Link href={`/analytics${link}`} className="flex items-center gap-1 text-[11px] text-mist-400 hover:text-mist-100">Analytics <ArrowUpRight size={12} /></Link>}
            />
            <TrendArea
              data={series}
              series={[
                { key: "impressions", name: "Impressions", color: VIZ[0] },
                { key: "reach", name: "Reach", color: VIZ[1] },
                { key: "engagements", name: "Engagements", color: VIZ[2] },
              ]}
            />
          </Card>

          <Card>
            <SectionTitle title="Where reach comes from" hint="Share of impressions by channel" />
            <DonutChart
              data={channels.map((c) => ({
                name: channelMeta(c.channel).label,
                value: c.impressions,
                color: channelMeta(c.channel).color,
              }))}
            />
            <div className="mt-3 space-y-2">
              {channels.slice(0, 5).map((c) => (
                <div key={c.channel} className="flex items-center gap-2 text-[11.5px]">
                  <Dot color={channelMeta(c.channel).color} />
                  <span className="flex-1 truncate text-mist-300">{channelMeta(c.channel).label}</span>
                  <span className="tnum text-mist-400">{fmt.pct(c.engagementRate, 2)}</span>
                  <span className="tnum w-12 text-right font-medium text-mist-100">{fmt.n(c.impressions)}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="grid gap-5 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <SectionTitle
              title="Paid performance — Meta + Google combined"
              hint="Daily spend and revenue with blended ROAS on the right axis"
              action={<Link href={`/ads${link}`} className="flex items-center gap-1 text-[11px] text-mist-400 hover:text-mist-100">Manage ads <ArrowUpRight size={12} /></Link>}
            />
            <ComboChart
              data={adSeries}
              bars={[
                { key: "spend", name: "Spend", color: VIZ[5] },
                { key: "revenue", name: "Revenue", color: VIZ[2] },
              ]}
              lines={[{ key: "roas", name: "ROAS", color: VIZ[3] }]}
            />
          </Card>

          <Card>
            <SectionTitle title="Channel performance" hint={`Impressions over ${days} days`} />
            <div className="space-y-3">
              {channels.map((c) => (
                <div key={c.channel}>
                  <div className="mb-1 flex items-center gap-2 text-[11.5px]">
                    <Dot color={channelMeta(c.channel).color} />
                    <span className="flex-1 text-mist-300">{channelMeta(c.channel).label}</span>
                    <span className="tnum text-mist-100">{fmt.n(c.impressions)}</span>
                    <span className={`tnum w-14 text-right ${c.followerDelta >= 0 ? "text-good-400" : "text-bad-400"}`}>
                      {c.followerDelta >= 0 ? "+" : ""}{fmt.n(c.followerDelta)}
                    </span>
                  </div>
                  <Bar value={c.impressions} max={maxImpr} color={channelMeta(c.channel).color} />
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="grid gap-5 xl:grid-cols-3">
          <div className="xl:col-span-2">
            <SectionTitle
              title={`${suggestions.length} AI recommendations`}
              hint="Ranked by severity, then by confidence-weighted projected impact"
              action={<Link href={`/insights${link}`} className="flex items-center gap-1 text-[11px] text-mist-400 hover:text-mist-100">See all <ArrowUpRight size={12} /></Link>}
            />
            <div className="space-y-2.5">
              {suggestions.slice(0, 5).map((s) => (
                <SuggestionCard key={s.id} s={s} compact />
              ))}
            </div>
          </div>

          <div>
            <SectionTitle title="Coming up" hint="Next posts in the queue" action={<Link href={`/calendar${link}`} className="text-[11px] text-mist-400 hover:text-mist-100">Calendar</Link>} />
            <div className="space-y-2">
              {upcoming.map((p) => (
                <div key={p.id} className="card p-3">
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="tnum text-[11px] font-medium text-mist-200">
                      {new Date(p.scheduledAt!).toLocaleString("en", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <Badge tone={p.status === "failed" ? "bad" : p.status === "needs_approval" ? "warn" : "neutral"}>
                      {p.status.replace("_", " ")}
                    </Badge>
                    {p.autoScheduled && <Badge tone="brand">auto-timed</Badge>}
                  </div>
                  <p className="line-clamp-2 text-[12px] leading-snug text-mist-300">{p.caption}</p>
                  <div className="mt-2 flex gap-1.5">
                    {p.targets.map((tg) => (
                      <span key={tg.connectionId} className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                        style={{ background: `${channelMeta(tg.channel).color}1f`, color: channelMeta(tg.channel).color }}>
                        {tg.format}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
              {!upcoming.length && <p className="card p-4 text-[12px] text-mist-400">Queue is empty — add posts from the composer.</p>}
            </div>
          </div>
        </div>

        <AdsCard rows={adStatsFor(db, brandId, range)} days={days} link={link} />

        {/* YouTube live overview — only renders when YouTube channel is connected */}
        <YouTubeSnapshotBlock brandId={brandId} />
      </div>
    </>
  );
}
