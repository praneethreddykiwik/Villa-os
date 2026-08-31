import { pageContext } from "@/lib/page-context";
import { TopBar } from "@/components/shell";
import { Card, SectionTitle, Stat, Bar, fmt } from "@/components/ui";
import { RatingGauge, StackedBars } from "@/components/charts";
import { ReviewsPanel } from "@/components/reviews-panel";

export const dynamic = "force-dynamic";

export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);
  const reviews = db.reviews.filter((r) => r.brandId === brandId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const avg = reviews.reduce((a, r) => a + r.rating, 0) / (reviews.length || 1);
  const replied = reviews.filter((r) => r.replied).length;
  const replyRate = (replied / (reviews.length || 1)) * 100;

  // Rating distribution per month, like the reference dashboard.
  const months = new Map<string, Record<string, number>>();
  for (const r of reviews) {
    const key = new Date(r.createdAt).toLocaleString("en", { month: "short" });
    const row = months.get(key) ?? { "5": 0, "4": 0, "3": 0, "2": 0, "1": 0 };
    row[String(r.rating)] = (row[String(r.rating)] ?? 0) + 1;
    months.set(key, row);
  }
  const monthly = [...months.entries()].map(([date, counts]) => ({ date, ...counts })).reverse();

  const dist = [5, 4, 3, 2, 1].map((star) => ({ star, count: reviews.filter((r) => r.rating === star).length }));
  const maxDist = Math.max(...dist.map((d) => d.count), 1);

  // Topic frequency across negative reviews — what to actually fix.
  const topics = new Map<string, { total: number; negative: number }>();
  for (const r of reviews) {
    for (const t of r.topics) {
      const row = topics.get(t) ?? { total: 0, negative: 0 };
      row.total += 1;
      if (r.rating <= 3) row.negative += 1;
      topics.set(t, row);
    }
  }
  const topicRows = [...topics.entries()].sort((a, b) => b[1].negative - a[1].negative || b[1].total - a[1].total).slice(0, 6);

  return (
    <>
      <TopBar brands={db.brands} brandId={brandId} title="Reviews" subtitle={`${reviews.length} reviews · ${replyRate.toFixed(0)}% answered · ${brand.name}`} />

      <div className="space-y-6 p-7">
        <div className="grid gap-3 md:grid-cols-4">
          <Stat label="Average rating" value={avg.toFixed(2)} sub={`${reviews.length} total reviews`} />
          <Stat label="Reply rate" value={fmt.pct(replyRate, 0)} sub={`${reviews.length - replied} unanswered`} />
          <Stat label="Negative open" value={String(reviews.filter((r) => r.rating <= 3 && !r.replied).length)} sub="3★ or below, no reply" />
          <Stat label="Last 30 days" value={String(reviews.filter((r) => Date.now() - new Date(r.createdAt).getTime() < 30 * 864e5).length)} sub="new reviews" />
        </div>

        <div className="grid gap-5 xl:grid-cols-3">
          <Card>
            <SectionTitle title="Overall rating" />
            <RatingGauge value={avg} />
            <div className="mt-3 space-y-1.5">
              {dist.map((d) => (
                <div key={d.star} className="flex items-center gap-2 text-[11px]">
                  <span className="tnum w-6 text-mist-400">{d.star}★</span>
                  <Bar value={d.count} max={maxDist} color={d.star >= 4 ? "#34d399" : d.star === 3 ? "#fbbf24" : "#fb7185"} />
                  <span className="tnum w-6 text-right text-mist-300">{d.count}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card className="xl:col-span-2">
            <SectionTitle title="Ratings over time" hint="Stacked by star rating, newest on the right" />
            <StackedBars
              data={monthly}
              series={[
                { key: "1", name: "1★", color: "#f43f5e" },
                { key: "2", name: "2★", color: "#fb923c" },
                { key: "3", name: "3★", color: "#fbbf24" },
                { key: "4", name: "4★", color: "#4ade80" },
                { key: "5", name: "5★", color: "#22c55e" },
              ]}
              height={200}
            />
            <div className="mt-4">
              <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-mist-400">What people mention</div>
              <div className="space-y-1.5">
                {topicRows.map(([topic, row]) => (
                  <div key={topic} className="flex items-center gap-2 text-[11.5px]">
                    <span className="w-24 truncate text-mist-300">{topic}</span>
                    <Bar value={row.total} max={Math.max(...topicRows.map(([, r]) => r.total))} color={row.negative > row.total / 2 ? "var(--color-bad-400)" : "var(--color-brand-500)"} />
                    <span className="tnum w-20 text-right text-mist-400">
                      {row.total} · <span className={row.negative ? "text-bad-400" : ""}>{row.negative} neg</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        </div>

        <ReviewsPanel reviews={reviews} brandId={brandId} />
      </div>
    </>
  );
}
