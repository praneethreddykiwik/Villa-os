import Link from "next/link";
import { pageContext, qs } from "@/lib/page-context";
import { adStatsFor, adTotals, previousRange, pctChange } from "@/lib/metrics/aggregate";
import { creativeFatigue, budgetReallocation, pacing } from "@/lib/ai/signals";
import { TopBar } from "@/components/shell";
import { Card, SectionTitle, Stat, Badge, Dot, Bar, fmt } from "@/components/ui";
import { ComboChart, DonutChart, VIZ } from "@/components/charts";
import { SuggestionCard } from "@/components/suggestion-card";
import { AD_CHANNELS } from "@/lib/platforms/registry";
import type { AdStat } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AdsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId, range, days } = pageContext(sp);
  const link = qs(sp);

  const rows = adStatsFor(db, brandId, range);
  const prevRows = adStatsFor(db, brandId, previousRange(range));
  const t = adTotals(rows);
  const tPrev = adTotals(prevRows);

  const suggestions = [
    ...creativeFatigue(db, brandId, range),
    ...budgetReallocation(db, brandId, range),
    ...pacing(db, brandId),
  ];

  // Platform split — the "Meta and Google in one place" view.
  const platforms = (["meta_ads", "google_ads"] as const).map((p) => {
    const pr = rows.filter((r) => r.platform === p);
    return { platform: p, ...adTotals(pr), meta: AD_CHANNELS[p] };
  });

  // Daily combined series.
  const daily = new Map<string, { date: string; meta: number; google: number; revenue: number; roas: number }>();
  for (const r of rows) {
    const d = daily.get(r.date) ?? { date: r.date, meta: 0, google: 0, revenue: 0, roas: 0 };
    if (r.platform === "meta_ads") d.meta += r.spend;
    else d.google += r.spend;
    d.revenue += r.conversionValue;
    daily.set(r.date, d);
  }
  const series = [...daily.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({
      ...d,
      meta: Number(d.meta.toFixed(0)),
      google: Number(d.google.toFixed(0)),
      revenue: Number(d.revenue.toFixed(0)),
      roas: Number(((d.meta + d.google) ? d.revenue / (d.meta + d.google) : 0).toFixed(2)),
    }));

  const campaigns = db.adCampaigns.filter((c) => c.brandId === brandId);
  const byId = (id: string, key: keyof AdStat) => rows.filter((r) => r[key] === id);
  const maxSpend = Math.max(...campaigns.map((c) => adTotals(byId(c.id, "campaignId")).spend), 1);

  return (
    <>
      <TopBar
        brands={db.brands}
        brandId={brandId}
        title="Ads — Meta + Google"
        subtitle={`${campaigns.length} campaigns · ${brand.name} · last ${days} days`}
      />

      <div className="space-y-6 p-7">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
          <Stat label="Spend" value={fmt.money(t.spend)} delta={pctChange(t.spend, tPrev.spend)} sub={`${fmt.money(t.spend / days)}/day`} />
          <Stat label="Revenue" value={fmt.money(t.conversionValue)} delta={pctChange(t.conversionValue, tPrev.conversionValue)} sub={`${Math.round(t.conversions)} conversions`} />
          <Stat label="ROAS" value={fmt.x(t.roas)} delta={pctChange(t.roas, tPrev.roas)} sub={`break-even at 1.00x`} />
          <Stat label="CPA" value={fmt.money(t.cpa)} delta={pctChange(t.cpa, tPrev.cpa)} invertDelta sub="cost per conversion" />
          <Stat label="CTR" value={fmt.pct(t.ctr, 2)} delta={pctChange(t.ctr, tPrev.ctr)} sub={`${fmt.money(t.cpc)} CPC`} />
          <Stat label="Frequency" value={`${t.frequency.toFixed(2)}x`} delta={pctChange(t.frequency, tPrev.frequency)} invertDelta sub="fatigue risk above 3x" />
        </div>

        <div className="grid gap-5 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <SectionTitle title="Spend by platform, revenue and blended ROAS" hint="Both ad platforms normalised onto one daily grain" />
            <ComboChart
              data={series}
              bars={[
                { key: "meta", name: "Meta Ads", color: "#0866FF" },
                { key: "google", name: "Google Ads", color: "#FBBC04" },
              ]}
              lines={[{ key: "roas", name: "Blended ROAS", color: VIZ[2] }]}
              height={280}
            />
          </Card>

          <Card>
            <SectionTitle title="Platform split" hint="Where the budget goes and what it returns" />
            <DonutChart data={platforms.map((p) => ({ name: p.meta.label, value: p.spend, color: p.meta.color }))} height={160} />
            <div className="mt-4 space-y-3">
              {platforms.map((p) => (
                <div key={p.platform} className="rounded-lg border border-ink-700 p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <Dot color={p.meta.color} />
                    <span className="flex-1 text-[12px] font-medium text-mist-100">{p.meta.label}</span>
                    <Badge tone={p.roas >= 2 ? "good" : p.roas >= 1 ? "warn" : "bad"}>{fmt.x(p.roas)}</Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-[11px]">
                    <div><div className="text-mist-400">Spend</div><div className="tnum font-medium">{fmt.money(p.spend)}</div></div>
                    <div><div className="text-mist-400">CPA</div><div className="tnum font-medium">{fmt.money(p.cpa)}</div></div>
                    <div><div className="text-mist-400">CTR</div><div className="tnum font-medium">{fmt.pct(p.ctr, 2)}</div></div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {suggestions.length > 0 && (
          <div>
            <SectionTitle title="What the engine found in your ad accounts" hint="Fatigue, allocation and pacing, checked every load" />
            <div className="space-y-2.5">
              {suggestions.slice(0, 4).map((s) => (
                <SuggestionCard key={s.id} s={s} compact />
              ))}
            </div>
          </div>
        )}

        <div>
          <SectionTitle title="Campaigns" hint="Click through to ad sets and creatives" />
          <div className="space-y-3">
            {campaigns.map((c) => {
              const ct = adTotals(byId(c.id, "campaignId"));
              const meta = AD_CHANNELS[c.platform];
              return (
                <div key={c.id} className="card overflow-hidden">
                  <div className="flex flex-wrap items-center gap-3 border-b border-ink-800 p-4">
                    <Dot color={meta.color} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-mist-100">{c.name}</div>
                      {/* endDate is optional — an evergreen campaign has none, and
                          `new Date("")` would print the literal "Invalid Date". */}
                      <div className="text-[11px] text-mist-400">
                        {meta.label} · {c.objective} · {c.adSets.length} ad sets ·{" "}
                        {c.endDate ? `ends ${new Date(c.endDate).toLocaleDateString()}` : "no end date"}
                      </div>
                    </div>
                    <Badge tone={c.status === "active" ? "good" : "neutral"}>{c.status}</Badge>
                    <div className="tnum grid grid-cols-4 gap-5 text-right text-[12px]">
                      <div><div className="text-[10px] uppercase text-mist-400">Spend</div><div className="font-medium">{fmt.money(ct.spend)}</div></div>
                      <div><div className="text-[10px] uppercase text-mist-400">Revenue</div><div className="font-medium">{fmt.money(ct.conversionValue)}</div></div>
                      <div><div className="text-[10px] uppercase text-mist-400">ROAS</div><div className={`font-medium ${ct.roas >= 2 ? "text-good-400" : ct.roas < 1 ? "text-bad-400" : ""}`}>{fmt.x(ct.roas)}</div></div>
                      <div><div className="text-[10px] uppercase text-mist-400">CPA</div><div className="font-medium">{fmt.money(ct.cpa)}</div></div>
                    </div>
                  </div>

                  <div className="px-4 py-2">
                    <Bar value={ct.spend} max={maxSpend} color={meta.color} />
                  </div>

                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-b border-ink-800 text-left text-[10px] uppercase tracking-wider text-mist-400">
                        <th className="px-4 py-2 font-medium">Ad set / creative</th>
                        <th className="px-3 py-2 font-medium">Audience</th>
                        <th className="px-3 py-2 text-right font-medium">Spend</th>
                        <th className="px-3 py-2 text-right font-medium">Impr.</th>
                        <th className="px-3 py-2 text-right font-medium">CTR</th>
                        <th className="px-3 py-2 text-right font-medium">Freq.</th>
                        <th className="px-3 py-2 text-right font-medium">Conv.</th>
                        <th className="px-4 py-2 text-right font-medium">ROAS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.adSets.map((s) => {
                        const st = adTotals(byId(s.id, "adSetId"));
                        return (
                          <tr key={s.id} className="border-b border-ink-800/60 last:border-0 hover:bg-ink-850/40">
                            <td className="px-4 py-2 font-medium text-mist-200">{s.name}</td>
                            <td className="px-3 py-2 text-mist-400">{s.audience}</td>
                            <td className="tnum px-3 py-2 text-right">{fmt.money(st.spend)}</td>
                            <td className="tnum px-3 py-2 text-right text-mist-300">{fmt.n(st.impressions)}</td>
                            <td className="tnum px-3 py-2 text-right text-mist-300">{fmt.pct(st.ctr, 2)}</td>
                            <td className={`tnum px-3 py-2 text-right ${st.frequency > 3 ? "text-warn-400" : "text-mist-300"}`}>
                              {st.frequency ? `${st.frequency.toFixed(1)}x` : "—"}
                            </td>
                            <td className="tnum px-3 py-2 text-right text-mist-300">{Math.round(st.conversions)}</td>
                            <td className={`tnum px-4 py-2 text-right font-medium ${st.roas >= 2 ? "text-good-400" : st.roas < 1 ? "text-bad-400" : "text-mist-200"}`}>
                              {fmt.x(st.roas)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        </div>

        <p className="text-[11px] text-mist-400">
          Budget and status changes made here write straight to the platform through the Marketing API.{" "}
          <Link href={`/connections${link}`} className="text-brand-400 hover:underline">Check connections</Link> if a write fails.
        </p>
      </div>
    </>
  );
}
