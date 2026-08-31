import { pageContext } from "@/lib/page-context";
import { localVisibility } from "@/lib/ai/signals";
import { rollupByChannel, statsFor, timeseries, totals, previousRange, pctChange } from "@/lib/metrics/aggregate";
import { TopBar } from "@/components/shell";
import { Card, SectionTitle, Stat, Badge, fmt } from "@/components/ui";
import { TrendArea, VIZ } from "@/components/charts";
import { SuggestionCard } from "@/components/suggestion-card";

export const dynamic = "force-dynamic";

/** Rank 1–3 green, 4–10 amber, 11+ red — the standard local-pack reading. */
function rankColor(rank: number): string {
  if (rank <= 3) return "#22c55e";
  if (rank <= 10) return "#fbbf24";
  return "#f43f5e";
}

export default async function LocalPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId, range } = pageContext(sp);

  const cells = db.rankGrid.filter((c) => c.brandId === brandId);
  const keywords = [...new Set(cells.map((c) => c.keyword))];
  const suggestions = localVisibility(db, brandId);

  const stats = statsFor(db, brandId).filter((s) => s.channel === "google_business");
  const t = totals(stats, range);
  const tPrev = totals(stats, previousRange(range));
  const series = timeseries(stats, range);
  const gbp = rollupByChannel(stats, range)[0];

  const competitors = db.competitors.filter((c) => c.brandId === brandId);

  return (
    <>
      <TopBar brands={db.brands} brandId={brandId} title="Local visibility" subtitle={`Google Business Profile & local pack · ${brand.name}`} />

      <div className="space-y-6 p-7">
        <div className="grid gap-3 md:grid-cols-4">
          <Stat label="Profile views" value={fmt.n(t.impressions)} delta={pctChange(t.impressions, tPrev.impressions)} sub="Search + Maps combined" />
          <Stat label="Interactions" value={fmt.n(t.engagements)} delta={pctChange(t.engagements, tPrev.engagements)} sub="calls, directions, clicks" />
          <Stat label="Website clicks" value={fmt.n(t.linkClicks)} delta={pctChange(t.linkClicks, tPrev.linkClicks)} sub="from the profile" />
          <Stat
            label="Top-3 coverage"
            value={fmt.pct((cells.filter((c) => c.rank <= 3).length / (cells.length || 1)) * 100, 0)}
            sub={`across ${keywords.length} tracked keywords`}
          />
        </div>

        <div className="grid gap-5 xl:grid-cols-2">
          {keywords.map((kw) => {
            const kwCells = cells.filter((c) => c.keyword === kw);
            const avg = kwCells.reduce((a, c) => a + c.rank, 0) / kwCells.length;
            return (
              <Card key={kw}>
                <SectionTitle
                  title={`"${kw}"`}
                  hint={`Average position ${avg.toFixed(1)} across a 5×5 grid around the business`}
                  action={<Badge tone={avg <= 3 ? "good" : avg <= 8 ? "warn" : "bad"}>avg {avg.toFixed(1)}</Badge>}
                />
                {/* The map-grid view: each cell is a search from that point. */}
                <div className="relative overflow-hidden rounded-xl bg-ink-850 p-4">
                  <div
                    className="absolute inset-0 opacity-[0.13]"
                    style={{
                      backgroundImage:
                        "linear-gradient(#93a0bb 1px, transparent 1px), linear-gradient(90deg, #93a0bb 1px, transparent 1px)",
                      backgroundSize: "34px 34px",
                    }}
                  />
                  <div className="relative grid grid-cols-5 gap-2.5">
                    {kwCells
                      .sort((a, b) => a.row - b.row || a.col - b.col)
                      .map((c) => (
                        <div
                          key={`${c.row}-${c.col}`}
                          title={`${c.lat.toFixed(3)}, ${c.lng.toFixed(3)} — rank ${c.rank}`}
                          className="tnum grid aspect-square place-items-center rounded-full text-[13px] font-bold text-white shadow-lg"
                          style={{ background: rankColor(c.rank) }}
                        >
                          {c.rank >= 20 ? "20+" : c.rank}
                        </div>
                      ))}
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-4 text-[10.5px] text-mist-400">
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[#22c55e]" /> top 3</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[#fbbf24]" /> 4–10</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[#f43f5e]" /> 11+</span>
                  <span className="ml-auto">Captured {new Date(kwCells[0].capturedAt).toLocaleDateString()}</span>
                </div>
              </Card>
            );
          })}
        </div>

        <div className="grid gap-5 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <SectionTitle title="Google Business Profile activity" hint="Views and interactions from Search and Maps" />
            <TrendArea
              data={series}
              series={[
                { key: "impressions", name: "Profile views", color: VIZ[0] },
                { key: "engagements", name: "Interactions", color: VIZ[2] },
                { key: "linkClicks", name: "Website clicks", color: VIZ[3] },
              ]}
              height={220}
            />
            {gbp && (
              <div className="mt-3 grid grid-cols-3 gap-3 text-[11.5px]">
                <div><div className="text-mist-400">Engagement rate</div><div className="tnum font-medium">{fmt.pct(gbp.engagementRate, 2)}</div></div>
                <div><div className="text-mist-400">Posts published</div><div className="tnum font-medium">{gbp.posts}</div></div>
                <div><div className="text-mist-400">Reach</div><div className="tnum font-medium">{fmt.n(gbp.reach)}</div></div>
              </div>
            )}
          </Card>

          <Card>
            <SectionTitle title="Competitors nearby" hint="Rating, reviews and estimated ad spend" />
            <div className="space-y-2.5">
              {competitors.map((c) => (
                <div key={c.id} className="rounded-lg border border-ink-700 p-2.5">
                  <div className="flex items-center gap-2">
                    <span className="flex-1 truncate text-[12.5px] font-medium text-mist-100">{c.name}</span>
                    <Badge tone={c.rating >= 4.5 ? "good" : c.rating >= 4 ? "warn" : "bad"}>{c.rating.toFixed(1)}★</Badge>
                  </div>
                  <div className="mt-1.5 grid grid-cols-3 gap-2 text-[10.5px] text-mist-400">
                    <div><div>Reviews</div><div className="tnum text-mist-200">{c.reviewCount}</div></div>
                    <div><div>Posts/wk</div><div className="tnum text-mist-200">{c.postsPerWeek}</div></div>
                    <div><div>Est. spend</div><div className="tnum text-mist-200">{fmt.moneyCompact(c.estimatedAdSpend30d)}</div></div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {suggestions.length > 0 && (
          <div>
            <SectionTitle title="How to win the weak cells" hint="Read from the grid above" />
            <div className="space-y-2.5">
              {suggestions.map((s) => (
                <SuggestionCard key={s.id} s={s} />
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
