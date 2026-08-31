import Link from "next/link";
import { pageContext, qs } from "@/lib/page-context";
import { suggestSlots } from "@/lib/engine/besttime";
import { channelMeta } from "@/lib/platforms/registry";
import { TopBar } from "@/components/shell";
import { Card, Badge, fmt } from "@/components/ui";
import { CalendarView, type CalendarPost } from "@/components/calendar-view";

export const dynamic = "force-dynamic";

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);
  const link = qs(sp);

  const posts: CalendarPost[] = db.posts
    .filter((p) => p.brandId === brandId && p.scheduledAt)
    .map((p) => ({
      id: p.id,
      caption: p.caption,
      status: p.status,
      scheduledAt: p.scheduledAt!,
      autoScheduled: p.autoScheduled,
      error: p.targets.find((t) => t.error)?.error,
      channels: p.targets.map((t) => ({
        channel: t.channel,
        label: channelMeta(t.channel).label,
        color: channelMeta(t.channel).color,
        format: t.format,
      })),
    }));

  const slots = suggestSlots(db, brandId, { count: 8 }).map((s) => ({
    isoTime: s.isoTime,
    reason: s.reason,
    confidence: s.confidence,
  }));

  const queued = posts.filter((p) => ["scheduled", "approved", "needs_approval"].includes(p.status));
  const failed = posts.filter((p) => p.status === "failed");
  const awaiting = posts.filter((p) => p.status === "needs_approval");

  return (
    <>
      <TopBar
        brands={db.brands}
        brandId={brandId}
        title="Calendar"
        subtitle={`${queued.length} queued · ${awaiting.length} awaiting approval · ${brand.name}`}
        right={
          <Link href={`/composer${link}`} className="rounded-lg bg-brand-500 px-3 py-1.5 text-[12px] font-medium text-[var(--a-on)] hover:bg-brand-600">
            Compose
          </Link>
        }
      />

      <div className="space-y-5 p-7">
        <div className="grid gap-3 md:grid-cols-4">
          <Card><div className="text-[11px] uppercase tracking-wider text-mist-400">Scheduled</div><div className="tnum mt-1 text-2xl font-semibold">{queued.length}</div></Card>
          <Card><div className="text-[11px] uppercase tracking-wider text-mist-400">Awaiting approval</div><div className="tnum mt-1 text-2xl font-semibold text-warn-400">{awaiting.length}</div></Card>
          <Card><div className="text-[11px] uppercase tracking-wider text-mist-400">Failed</div><div className="tnum mt-1 text-2xl font-semibold text-bad-400">{failed.length}</div></Card>
          <Card><div className="text-[11px] uppercase tracking-wider text-mist-400">Published all-time</div><div className="tnum mt-1 text-2xl font-semibold">{fmt.n(posts.filter((p) => p.status === "published").length)}</div></Card>
        </div>

        {failed.length > 0 && (
          <Card className="border-bad-500/30 bg-bad-500/[0.04]">
            <div className="mb-2 flex items-center gap-2">
              <Badge tone="bad">{failed.length} failed</Badge>
              <span className="text-[12px] text-mist-300">These stay in the queue and retry once the cause is cleared.</span>
            </div>
            {failed.map((p) => (
              <div key={p.id} className="mt-1.5 text-[11.5px] text-mist-400">
                <span className="text-mist-200">{p.caption.slice(0, 50)}</span> — {p.error}
              </div>
            ))}
          </Card>
        )}

        <Card>
          <CalendarView posts={posts} slots={slots} brandColor={brand.color} />
        </Card>
      </div>
    </>
  );
}
