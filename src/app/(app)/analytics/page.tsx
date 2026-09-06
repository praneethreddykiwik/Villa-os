import { pageContext, qs } from "@/lib/page-context";
import {
  adStatsFor, previousRange, pctChange, rollupByChannel, statsFor, timeseries, totals,
} from "@/lib/metrics/aggregate";
import { ensureFreshStats } from "@/lib/engine/freshness";
import { buildHeatmap, DAY_NAMES } from "@/lib/engine/besttime";
import { channelMeta } from "@/lib/platforms/registry";
import { TopBar } from "@/components/shell";
import { Card, SectionTitle, Stat, Badge, Dot, Bar, fmt } from "@/components/ui";
import { TrendArea, VIZ } from "@/components/charts";
import { YouTubeSnapshotBlock } from "@/components/analytics/youtube-snapshot-block";
import { YouTubeSection } from "@/components/analytics/youtube-section";
import { SocialOverview } from "@/components/analytics/social-overview";
import { AdsCard } from "@/components/analytics/ads-card";
import { UploadPostLiveStudio } from "@/components/analytics/uploadpost-live-studio";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  // Refresh YouTube rows older than ten minutes before reading; a failed
  // refresh renders the stale store rather than an error.
  const pre = pageContext(sp);
  const fresh = await ensureFreshStats(pre.brandId);
  const { db, brand, brandId, range, days } = fresh.refreshed ? pageContext(sp) : pre;
  const link = qs(sp);

  const stats = statsFor(db, brandId);
  const t = totals(stats, range);
  const tPrev = totals(stats, previousRange(range));
  const channels = rollupByChannel(stats, range);
  const series = timeseries(stats, range);

  // The heatmap comes back empty when this brand has no published post with
  // metrics — there is no history to shrink towards, so there is nothing to plot.
  const heat = buildHeatmap(db, brandId);
  const maxHeat = Math.max(...heat.map((c) => c.score), 0.001);

  const published = db.posts
    .filter((p) => p.brandId === brandId && p.status === "published" && p.metrics && p.publishedAt! >= `${range.from}T00:00:00`)
    .sort((a, b) => b.metrics!.reach - a.metrics!.reach);

  // Format performance table — reach and engagement per format.
  const formatRows = new Map<string, { n: number; reach: number; er: number; retention: number }>();
  for (const p of published) {
    for (const tg of p.targets) {
      const row = formatRows.get(tg.format) ?? { n: 0, reach: 0, er: 0, retention: 0 };
      row.n += 1;
      row.reach += p.metrics!.reach;
      row.er += p.metrics!.engagementRate;
      row.retention += p.metrics!.retention3s;
      formatRows.set(tg.format, row);
    }
  }
  const formats = [...formatRows.entries()]
    .map(([format, r]) => ({ format, n: r.n, reach: r.reach / r.n, er: r.er / r.n, retention: r.retention / r.n }))
    .sort((a, b) => b.reach - a.reach);
  const maxFormatReach = Math.max(...formats.map((f) => f.reach), 1);

  return (
    <>
      <TopBar brands={db.brands} brandId={brandId} title="Analytics" subtitle={`${brand.name} · live multi-platform performance`} />

      <div className="space-y-6 p-7">
        <UploadPostLiveStudio brandId={brandId} />

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label="Impressions" value={fmt.n(t.impressions)} delta={pctChange(t.impressions, tPrev.impressions)} />
          <Stat label="Reach" value={fmt.n(t.reach)} delta={pctChange(t.reach, tPrev.reach)} />
          <Stat label="Engagements" value={fmt.n(t.engagements)} delta={pctChange(t.engagements, tPrev.engagements)} sub={fmt.pct(t.engagementRate, 2)} />
          <Stat label="Link clicks" value={fmt.n(t.linkClicks)} delta={pctChange(t.linkClicks, tPrev.linkClicks)} />
          <Stat label="Posts" value={String(t.posts)} delta={pctChange(t.posts, tPrev.posts)} sub={`${(t.posts / days * 7).toFixed(1)}/week`} />
        </div>

        <SocialOverview db={db} brandId={brandId} range={range} lastSyncedAt={fresh.lastSyncedAt} link={link} />

        <Card>
          <SectionTitle title="Everything over time" hint="All channels combined" />
          <TrendArea
            data={series}
            series={[
              { key: "impressions", name: "Impressions", color: VIZ[0] },
              { key: "reach", name: "Reach", color: VIZ[1] },
              { key: "engagements", name: "Engagements", color: VIZ[2] },
              { key: "linkClicks", name: "Link clicks", color: VIZ[3] },
            ]}
            height={280}
          />
        </Card>

        <div className="grid gap-5 xl:grid-cols-2">
          <Card>
            <SectionTitle
              title="When your audience actually responds"
              hint="Engagement rate by day and hour, shrunk toward the account mean so a single post cannot create a false hotspot"
            />
            {heat.length === 0 ? (
              <p className="py-10 text-center text-[12.5px] text-mist-400">
                No timing signal yet. This grid is built only from {brand.name}&apos;s own published posts,
                so it stays empty until the first ones go out and report their metrics.
              </p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <div className="min-w-[560px]">
                    <div className="mb-1 grid grid-cols-[34px_repeat(24,1fr)] gap-[2px]">
                      <span />
                      {Array.from({ length: 24 }).map((_, h) => (
                        <span key={h} className="tnum text-center text-[8px] text-mist-500">{h % 3 === 0 ? h : ""}</span>
                      ))}
                    </div>
                    {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                      <div key={day} className="mb-[2px] grid grid-cols-[34px_repeat(24,1fr)] gap-[2px]">
                        <span className="text-[9.5px] leading-4 text-mist-400">{DAY_NAMES[day]}</span>
                        {Array.from({ length: 24 }).map((_, hour) => {
                          const c = heat.find((x) => x.day === day && x.hour === hour)!;
                          const intensity = c.score / maxHeat;
                          return (
                            <span
                              key={hour}
                              title={`${DAY_NAMES[day]} ${hour}:00 — ${c.raw.toFixed(1)}% from ${c.samples} post(s)`}
                              className="h-4 rounded-[2px]"
                              style={{
                                background: `rgba(91,108,255,${(0.08 + intensity * 0.92).toFixed(2)})`,
                                outline: c.samples >= 3 ? "1px solid rgba(255,255,255,0.22)" : "none",
                              }}
                            />
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
                <p className="mt-2 text-[10.5px] text-mist-400">
                  Outlined cells have 3+ posts behind them — those are evidence. The rest are extrapolated from the account average.
                </p>
              </>
            )}
          </Card>

          <Card>
            <SectionTitle title="Format performance" hint="Average per post, this period" />
            {formats.length === 0 ? (
              <p className="py-6 text-center text-[12.5px] text-mist-400">
                Nothing published in the last {days} days, so there is no format to compare.
              </p>
            ) : (
              <div className="space-y-3">
                {formats.map((f) => (
                  <div key={f.format}>
                    <div className="mb-1 flex items-center gap-2 text-[11.5px]">
                      <span className="w-16 capitalize text-mist-300">{f.format}</span>
                      <span className="tnum text-mist-400">{f.n} posts</span>
                      <span className="tnum ml-auto text-mist-100">{fmt.n(f.reach)} reach</span>
                      <span className="tnum w-12 text-right text-mist-400">{fmt.pct(f.er, 1)}</span>
                    </div>
                    <Bar value={f.reach} max={maxFormatReach} />
                  </div>
                ))}
              </div>
            )}

            <div className="mt-5">
              <SectionTitle title="Channel table" />
              {channels.length === 0 ? (
                <p className="py-6 text-center text-[12.5px] text-mist-400">
                  No channel reported any activity in this period.
                </p>
              ) : (
                <table className="w-full text-[11.5px]">
                  <thead>
                    <tr className="border-b border-ink-800 text-left text-[10px] uppercase tracking-wider text-mist-400">
                      <th className="py-1.5 font-medium">Channel</th>
                      <th className="py-1.5 text-right font-medium">Followers</th>
                      <th className="py-1.5 text-right font-medium">Net</th>
                      <th className="py-1.5 text-right font-medium">Impr.</th>
                      <th className="py-1.5 text-right font-medium">Eng. rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {channels.map((c) => (
                      <tr key={c.channel} className="border-b border-ink-800/60 last:border-0">
                        <td className="py-1.5">
                          <span className="flex items-center gap-1.5">
                            <Dot color={channelMeta(c.channel).color} />
                            {channelMeta(c.channel).label}
                          </span>
                        </td>
                        <td className="tnum py-1.5 text-right">{fmt.n(c.followers)}</td>
                        <td className={`tnum py-1.5 text-right ${c.followerDelta >= 0 ? "text-good-400" : "text-bad-400"}`}>
                          {c.followerDelta >= 0 ? "+" : ""}{fmt.n(c.followerDelta)}
                        </td>
                        <td className="tnum py-1.5 text-right">{fmt.n(c.impressions)}</td>
                        <td className="tnum py-1.5 text-right">{fmt.pct(c.engagementRate, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Card>
        </div>

        <Card>
          <SectionTitle title="Top content" hint="Ranked by reach, with the 3-second hook score that drove it" />
          {published.length === 0 ? (
            <p className="py-10 text-center text-[12.5px] text-mist-400">
              No posts have been published for {brand.name} in the last {days} days. Publish from the
              composer and results land here once each channel reports back.
            </p>
          ) : (
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-ink-800 text-left text-[10px] uppercase tracking-wider text-mist-400">
                  <th className="py-2 font-medium">Post</th>
                  <th className="py-2 font-medium">Channels</th>
                  <th className="py-2 text-right font-medium">Reach</th>
                  <th className="py-2 text-right font-medium">Eng.</th>
                  <th className="py-2 text-right font-medium">Rate</th>
                  <th className="py-2 text-right font-medium">3s hook</th>
                  <th className="py-2 text-right font-medium">Saves</th>
                </tr>
              </thead>
              <tbody>
                {published.slice(0, 10).map((p) => (
                  <tr key={p.id} className="border-b border-ink-800/60 last:border-0 hover:bg-ink-850/40">
                    <td className="max-w-[320px] truncate py-2 text-mist-200">{p.caption}</td>
                    <td className="py-2">
                      <span className="flex gap-1">
                        {p.targets.map((tg) => (
                          <span key={tg.connectionId} className="h-2 w-2 rounded-full" style={{ background: channelMeta(tg.channel).color }} title={channelMeta(tg.channel).label} />
                        ))}
                      </span>
                    </td>
                    <td className="tnum py-2 text-right">{fmt.n(p.metrics?.reach ?? 0)}</td>
                    <td className="tnum py-2 text-right text-mist-300">
                      {fmt.n((p.metrics?.likes ?? 0) + (p.metrics?.comments ?? 0) + (p.metrics?.shares ?? 0) + (p.metrics?.saves ?? 0))}
                    </td>
                    <td className="tnum py-2 text-right">{fmt.pct(p.metrics?.engagementRate ?? 0, 1)}</td>
                    <td className="py-2 text-right">
                      <Badge tone={(p.metrics?.retention3s ?? 0) >= 0.65 ? "good" : (p.metrics?.retention3s ?? 0) >= 0.45 ? "warn" : "bad"}>
                        {fmt.pct((p.metrics?.retention3s ?? 0) * 100, 0)}
                      </Badge>
                    </td>
                    <td className="tnum py-2 text-right text-mist-300">{fmt.n(p.metrics?.saves ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {/* YouTube: synced series + live totals; renders nothing when not connected */}
        <YouTubeSection db={db} brandId={brandId} range={range} days={days} lastSyncedAt={fresh.lastSyncedAt} />

        <AdsCard rows={adStatsFor(db, brandId, range)} days={days} link={link} />

        {/* YouTube live overview — renders itself only when YouTube is connected */}
        <YouTubeSnapshotBlock brandId={brandId} />
      </div>
    </>
  );
}
