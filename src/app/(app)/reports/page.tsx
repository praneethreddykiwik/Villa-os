import { pageContext } from "@/lib/page-context";
import {
  adStatsFor, adTotals, previousRange, rollupByChannel, statsFor, timeseries, totals, pctChange,
} from "@/lib/metrics/aggregate";
import { generateSuggestions } from "@/lib/ai/signals";
import { deterministicSummary } from "@/lib/ai/narrative";
import { channelMeta } from "@/lib/platforms/registry";
import { TopBar } from "@/components/shell";
import { Card, SectionTitle, Stat, Badge, Dot, fmt } from "@/components/ui";
import { TrendArea, VIZ } from "@/components/charts";
import { PrintButton } from "@/components/print-button";

export const dynamic = "force-dynamic";

/**
 * Client-ready report. Composed of the same blocks the report builder stores, so
 * "what you see" and "what gets emailed on the 1st" are the same renderer.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId, range, days } = pageContext(sp);

  const stats = statsFor(db, brandId);
  const t = totals(stats, range);
  const tPrev = totals(stats, previousRange(range));
  const ads = adTotals(adStatsFor(db, brandId, range));
  const adsPrev = adTotals(adStatsFor(db, brandId, previousRange(range)));
  const channels = rollupByChannel(stats, range);
  const series = timeseries(stats, range);
  const suggestions = generateSuggestions(db, brandId, range);
  const reviews = db.reviews.filter((r) => r.brandId === brandId);
  const report = db.reports.find((r) => r.brandId === brandId) ?? db.reports[0];

  // Same gate as the dashboard. The summary only rewrites the totals — it never
  // adds facts — so with nothing measured every figure in it is a zero, and
  // "reached 0 people ... 0.00x ROAS" is a fluent paragraph about nothing. That
  // matters more here than anywhere else: this page is what gets printed and
  // emailed to the client on the 1st.
  const hasReportableData =
    t.impressions > 0 || t.engagements > 0 || t.posts > 0 || ads.spend > 0 || ads.impressions > 0;
  const summary = hasReportableData
    ? deterministicSummary({
        brand, period: `the last ${days} days`, totals: t, previousTotals: tPrev,
        ads, previousAds: adsPrev, suggestions,
      })
    : null;

  const topPosts = db.posts
    .filter((p) => p.brandId === brandId && p.status === "published" && p.metrics && p.publishedAt! >= `${range.from}T00:00:00`)
    .sort((a, b) => b.metrics!.reach - a.metrics!.reach)
    .slice(0, 5);

  return (
    <>
      <TopBar
        brands={db.brands}
        brandId={brandId}
        title="Reports"
        subtitle={report?.schedule ? `Auto-sends ${report.schedule.cadence} to ${report.schedule.recipients.join(", ")}` : "Client-ready report"}
        right={<PrintButton />}
      />

      <div className="p-7">
        <div className="mx-auto max-w-4xl space-y-5">
          <Card className="border-brand-500/25 bg-gradient-to-br from-brand-500/[0.06] to-transparent">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-[20px] font-semibold tracking-tight">{brand.name}</h2>
                <p className="text-[12px] text-mist-400">
                  Performance report · {range.from} → {range.to} · prepared {new Date().toLocaleDateString()}
                </p>
              </div>
              <span className="h-9 w-9 rounded-lg" style={{ background: brand.color }} />
            </div>
            {summary ? (
              <p className="mt-4 text-[13px] leading-relaxed text-mist-200">{summary}</p>
            ) : (
              <p className="mt-4 text-[13px] leading-relaxed text-mist-400">
                Nothing was measured for {brand.name} in this period — no posts published, no ad
                spend, no channel reporting between {range.from} and {range.to}. The written
                summary appears here once there is activity to report.
              </p>
            )}
          </Card>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Reach" value={fmt.n(t.reach)} delta={pctChange(t.reach, tPrev.reach)} />
            <Stat label="Engagements" value={fmt.n(t.engagements)} delta={pctChange(t.engagements, tPrev.engagements)} />
            <Stat label="New followers" value={fmt.full(t.followerDelta)} delta={pctChange(t.followerDelta, tPrev.followerDelta)} />
            <Stat label="ROAS" value={fmt.x(ads.roas)} delta={pctChange(ads.roas, adsPrev.roas)} />
          </div>

          <Card>
            <SectionTitle title="Reach & engagement" />
            <TrendArea
              data={series}
              series={[
                { key: "reach", name: "Reach", color: VIZ[1] },
                { key: "engagements", name: "Engagements", color: VIZ[2] },
              ]}
              height={200}
            />
          </Card>

          <Card>
            <SectionTitle title="Channel breakdown" />
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-ink-800 text-left text-[10px] uppercase tracking-wider text-mist-400">
                  <th className="py-2 font-medium">Channel</th>
                  <th className="py-2 text-right font-medium">Followers</th>
                  <th className="py-2 text-right font-medium">Net new</th>
                  <th className="py-2 text-right font-medium">Impressions</th>
                  <th className="py-2 text-right font-medium">Engagements</th>
                  <th className="py-2 text-right font-medium">Rate</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((c) => (
                  <tr key={c.channel} className="border-b border-ink-800/60 last:border-0">
                    <td className="py-2"><span className="flex items-center gap-1.5"><Dot color={channelMeta(c.channel).color} />{channelMeta(c.channel).label}</span></td>
                    <td className="tnum py-2 text-right">{fmt.full(c.followers)}</td>
                    <td className={`tnum py-2 text-right ${c.followerDelta >= 0 ? "text-good-400" : "text-bad-400"}`}>{c.followerDelta >= 0 ? "+" : ""}{fmt.full(c.followerDelta)}</td>
                    <td className="tnum py-2 text-right">{fmt.full(c.impressions)}</td>
                    <td className="tnum py-2 text-right">{fmt.full(c.engagements)}</td>
                    <td className="tnum py-2 text-right">{fmt.pct(c.engagementRate, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card>
            <SectionTitle title="Paid performance" hint="Meta Ads and Google Ads combined" />
            <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
              <Stat label="Spend" value={fmt.money(ads.spend)} />
              <Stat label="Revenue" value={fmt.money(ads.conversionValue)} />
              <Stat label="ROAS" value={fmt.x(ads.roas)} />
              <Stat label="CPA" value={fmt.money(ads.cpa)} />
              <Stat label="CTR" value={fmt.pct(ads.ctr, 2)} />
              <Stat label="CPM" value={fmt.money(ads.cpm)} />
            </div>
          </Card>

          <Card>
            <SectionTitle title="Top content" />
            <div className="space-y-2">
              {topPosts.map((p, i) => (
                <div key={p.id} className="flex items-center gap-3 rounded-lg border border-ink-700 p-2.5">
                  <span className="tnum text-[13px] font-semibold text-mist-400">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] text-mist-100">{p.caption}</span>
                    <span className="text-[10.5px] text-mist-400">{new Date(p.publishedAt!).toLocaleDateString()} · {p.targets.map((tg) => channelMeta(tg.channel).label).join(", ")}</span>
                  </span>
                  <span className="tnum text-right text-[12px]">
                    <span className="block font-medium">{fmt.n(p.metrics!.reach)}</span>
                    <span className="block text-[10px] text-mist-400">reach</span>
                  </span>
                  <span className="tnum text-right text-[12px]">
                    <span className="block font-medium">{fmt.pct(p.metrics!.engagementRate, 1)}</span>
                    <span className="block text-[10px] text-mist-400">rate</span>
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <SectionTitle title="Reputation" />
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Average rating" value={(reviews.reduce((a, r) => a + r.rating, 0) / (reviews.length || 1)).toFixed(2)} />
              <Stat label="Total reviews" value={String(reviews.length)} />
              <Stat label="Reply rate" value={fmt.pct((reviews.filter((r) => r.replied).length / (reviews.length || 1)) * 100, 0)} />
            </div>
          </Card>

          <Card>
            <SectionTitle title="Recommended next steps" hint="Top 5 by projected impact" />
            <ol className="space-y-2.5">
              {suggestions.slice(0, 5).map((s, i) => (
                <li key={s.id} className="flex gap-3">
                  <span className="tnum text-[13px] font-semibold text-mist-400">{i + 1}</span>
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-[12.5px] font-medium text-mist-100">{s.title}</span>
                      <Badge tone={s.severity === "critical" ? "bad" : "brand"}>
                        {s.projectedImpact.value.toLocaleString()} {s.projectedImpact.unit}
                      </Badge>
                    </span>
                    <span className="mt-0.5 block text-[11.5px] leading-relaxed text-mist-400">{s.rationale}</span>
                  </span>
                </li>
              ))}
            </ol>
          </Card>

          {/* The block list only exists once a saved report defines one. Without it
              the label would trail off after the colon, which reads like the block
              names failed to load rather than "no report has been built yet". */}
          <p className="pb-6 text-center text-[10.5px] text-mist-500">
            {report?.blocks.length
              ? `Generated by Glentree · blocks: ${report.blocks.map((b) => b.title).join(" · ")}`
              : "Generated by Glentree"}
          </p>
        </div>
      </div>
    </>
  );
}
