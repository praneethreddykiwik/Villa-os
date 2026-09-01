import Link from "next/link";
import { Lightbulb } from "lucide-react";
import { pageContext, qs } from "@/lib/page-context";
import { TopBar } from "@/components/shell";
import { Card, Badge, Empty } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Post ideas, each with the *reason* it was generated — a review theme, a format
 * gap, a competitor move, a seasonal window. An idea without a reason is just a
 * prompt; with one it is a decision you can defend to a client.
 */
export default async function IdeasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);
  const link = qs(sp);
  const ideas = db.ideas.filter((i) => i.brandId === brandId).sort((a, b) => b.score - a.score);

  return (
    <>
      <TopBar brands={db.brands} brandId={brandId} title="Post ideas" subtitle={`${ideas.length} ideas generated from your own data · ${brand.name}`} />

      <div className="p-7">
        {/* Ideas are derived from this brand's own signals, so an empty store means
            there is nothing to derive from yet. Saying so beats a page header
            floating above an empty grid, which reads as a failed fetch. */}
        {ideas.length === 0 ? (
          <Empty
            title={`No ideas for ${brand.name} yet`}
            hint="Ideas are generated from your own reviews, format gaps, competitor moves and seasonal windows. Once there is activity to read, they show up here."
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {ideas.map((i) => (
              <Card key={i.id} className="card-hover flex flex-col">
                <div className="mb-2 flex items-center gap-2">
                  <span className="grid h-6 w-6 place-items-center rounded-lg bg-warn-500/12 text-warn-400"><Lightbulb size={12} /></span>
                  <Badge tone="neutral">{i.format}</Badge>
                  <Badge tone="neutral">{i.angle}</Badge>
                  <span className="tnum ml-auto text-[11px] font-semibold text-mist-200">{i.score}</span>
                </div>
                <h3 className="text-[13.5px] font-semibold leading-snug text-mist-100">{i.title}</h3>
                <p className="mt-1.5 text-[12px] italic leading-relaxed text-mist-300">&ldquo;{i.hook}&rdquo;</p>

                <ol className="mt-3 space-y-1 text-[11.5px] text-mist-400">
                  {i.outline.map((step, n) => (
                    <li key={n} className="flex gap-2">
                      <span className="tnum text-mist-500">{n + 1}.</span>
                      {step}
                    </li>
                  ))}
                </ol>

                <div className="mt-3 rounded-lg border border-ink-700 bg-ink-850/60 px-2.5 py-2">
                  <div className="text-[10px] font-medium uppercase tracking-wider text-mist-400">Why now</div>
                  <p className="mt-0.5 text-[11.5px] leading-relaxed text-mist-300">{i.reason}</p>
                </div>

                <Link
                  href={`/composer${link}`}
                  className="mt-3 rounded-lg bg-brand-500 px-3 py-1.5 text-center text-[12px] font-medium text-[var(--a-on)] hover:bg-brand-600"
                >
                  Open in composer
                </Link>
              </Card>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
